require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const OpenAI = require("openai");
const pdfParse = require("pdf-parse");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!process.env.PASSCODE || !process.env.JWT_SECRET) {
  console.warn("Set PASSCODE and JWT_SECRET in environment before publishing.");
}
const db = new Database(path.join(DATA_DIR, "revision-target.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS questions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 batch_id TEXT NOT NULL, qno INTEGER, question TEXT NOT NULL, options TEXT NOT NULL,
 answer TEXT, explanation TEXT DEFAULT '', topic TEXT DEFAULT '', source_date TEXT NOT NULL,
 origin TEXT DEFAULT 'uploaded', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT NOT NULL, test_type TEXT NOT NULL,
 test_label TEXT NOT NULL, question_ids TEXT NOT NULL, answers TEXT NOT NULL,
 correct INTEGER NOT NULL, wrong INTEGER NOT NULL, skipped INTEGER NOT NULL,
 score REAL NOT NULL, max_score REAL NOT NULL, percent REAL NOT NULL,
 duration_seconds INTEGER NOT NULL, completed_at TEXT NOT NULL, daily_date TEXT
);
CREATE TABLE IF NOT EXISTS daily_completions (
 user_name TEXT NOT NULL, day TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(user_name, day)
);
CREATE TABLE IF NOT EXISTS batches (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, created_at TEXT NOT NULL, question_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_sessions (
 user_name TEXT NOT NULL, day TEXT NOT NULL, section TEXT NOT NULL, question_ids TEXT NOT NULL,
 PRIMARY KEY(user_name, day, section)
);
`);
app.use(express.json({limit:"12mb"}));
app.use(express.static(path.join(__dirname, "public")));
const storage = multer.diskStorage({
 destination: (_req,_file,cb)=>cb(null,UPLOAD_DIR),
 filename: (_req,file,cb)=>cb(null,Date.now()+"-"+crypto.randomBytes(5).toString("hex")+"-"+file.originalname.replace(/[^a-zA-Z0-9._-]/g,"_"))
});
const upload = multer({storage, limits:{fileSize:25*1024*1024, files:3}, fileFilter:(_req,file,cb)=>{
  if (file.mimetype==="application/pdf" || file.originalname.toLowerCase().endsWith(".pdf")) cb(null,true);
  else cb(new Error("केवल PDF फाइल स्वीकार है।"));
}});
function today(){ return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()); }
function auth(req,res,next){
 const hdr=req.headers.authorization||"";
 try { req.user=jwt.verify(hdr.replace(/^Bearer\s+/i,""),process.env.JWT_SECRET); next(); }
 catch { return res.status(401).json({error:"लॉगिन समाप्त है। दोबारा लॉगिन करें।"}); }
}
function aiClient(){
 if(!process.env.OPENAI_API_KEY) throw new Error("AI_API_MISSING");
 return new OpenAI({apiKey:process.env.OPENAI_API_KEY});
}
async function pdfText(file){
 if(!file) return "";
 const buf=fs.readFileSync(file.path);
 const parsed=await pdfParse(buf);
 return (parsed.text||"").trim();
}
function safeJson(text){
 const clean=text.replace(/```json|```/g,"").trim();
 const start=clean.indexOf("{"), end=clean.lastIndexOf("}");
 if(start<0||end<start) throw new Error("AI से सही JSON नहीं मिला। PDF स्पष्ट है या नहीं जाँचें।");
 return JSON.parse(clean.slice(start,end+1));
}
async function askAI(system, user, maxTokens=12000){
 const client=aiClient();
 const response=await client.chat.completions.create({
  model:process.env.OPENAI_MODEL||"gpt-4o-mini",
  temperature:0.2, response_format:{type:"json_object"}, max_tokens:maxTokens,
  messages:[{role:"system",content:system},{role:"user",content:user}]
 });
 return safeJson(response.choices[0].message.content||"{}");
}
function normalizeQuestions(arr, batchId, origin, sourceDate){
 return (arr||[]).map((q,i)=>{
  const options=Array.isArray(q.options)?q.options:[];
  const answer=String(q.answer||"").trim().toUpperCase().replace(/[^A-D]/g,"").slice(0,1);
  return {
   batch_id:batchId, qno:Number(q.number||q.qno||i+1),
   question:String(q.question||"").trim(),
   options:JSON.stringify(options.map((o,j)=>typeof o==="string"?o:String(o.text||o.label||""))),
   answer:["A","B","C","D"].includes(answer)?answer:null,
   explanation:String(q.explanation||"").trim(), topic:String(q.topic||"General").trim(),
   source_date:sourceDate, origin, created_at:new Date().toISOString()
  };
 }).filter(q=>q.question && JSON.parse(q.options).length>=2);
}
function insertQuestions(rows,label){
 const batchId=crypto.randomUUID();
 const insert=db.prepare(`INSERT INTO questions(batch_id,qno,question,options,answer,explanation,topic,source_date,origin,created_at)
 VALUES(@batch_id,@qno,@question,@options,@answer,@explanation,@topic,@source_date,@origin,@created_at)`);
 const tx=db.transaction(items=>items.forEach(q=>{q.batch_id=batchId;insert.run(q);}));
 tx(rows);
 db.prepare("INSERT INTO batches(id,label,created_at,question_count) VALUES(?,?,?,?)").run(batchId,label,new Date().toISOString(),rows.length);
 return batchId;
}
function getQuestionRows(ids){
 if(!ids.length) return [];
 const stmt=db.prepare("SELECT * FROM questions WHERE id=?");
 return ids.map(id=>stmt.get(id)).filter(Boolean).map(q=>({
  id:q.id,number:q.qno,question:q.question,options:JSON.parse(q.options),
  topic:q.topic, source_date:q.source_date
 }));
}
function shuffle(arr){
 const a=arr.slice();
 for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
 return a;
}
function publicQuestion(q){
 return {id:q.id,number:q.qno,question:q.question,options:JSON.parse(q.options),topic:q.topic,source_date:q.source_date};
}
app.get("/api/status",(_req,res)=>res.json({ready:!!process.env.PASSCODE,aiReady:!!process.env.OPENAI_API_KEY}));
app.post("/api/login",(req,res)=>{
 const {passcode,name}=req.body||{};
 if(!process.env.PASSCODE || String(passcode||"")!==process.env.PASSCODE) return res.status(401).json({error:"पासकोड सही नहीं है।"});
 const userName=String(name||"").trim().slice(0,60);
 if(userName.length<2) return res.status(400).json({error:"कृपया अपना नाम लिखें।"});
 const token=jwt.sign({name:userName},process.env.JWT_SECRET,{expiresIn:"7d"});
 res.json({token,name:userName});
});
app.get("/api/dashboard",auth,(req,res)=>{
 const name=req.user.name, day=today();
 const attempts=db.prepare("SELECT test_type,test_label,correct,wrong,skipped,score,max_score,percent,duration_seconds,completed_at FROM attempts WHERE user_name=? ORDER BY id DESC LIMIT 20").all(name);
 const totals=db.prepare("SELECT COUNT(*) n, COALESCE(AVG(percent),0) avg FROM attempts WHERE user_name=?").get(name);
 const points=db.prepare("SELECT COALESCE(SUM(points),0) n FROM daily_completions WHERE user_name=?").get(name).n;
 const done=db.prepare("SELECT 1 FROM daily_completions WHERE user_name=? AND day=?").get(name,day);
 const starCounts=attempts.map(x=>x.percent>98?5:x.percent>=90?4:3);
 res.json({name,day,attempts,totals,points,level:Math.min(5,Math.floor(points/7)+1),dailyComplete:!!done,starCounts});
});
app.get("/api/questions/meta",auth,(_req,res)=>{
 const count=db.prepare("SELECT COUNT(*) n FROM questions").get().n;
 const batches=db.prepare("SELECT id,label,created_at,question_count FROM batches ORDER BY created_at DESC").all();
 res.json({count,batches});
});
app.post("/api/import",auth,upload.fields([{name:"questions",maxCount:1},{name:"answerKey",maxCount:1},{name:"source",maxCount:1}]),async(req,res)=>{
 const files=req.files||{}, mode=String(req.body.mode||"pair");
 try{
  const date=today();
  if(mode==="source"){
   if(!files.source?.[0]) return res.status(400).json({error:"अध्ययन सामग्री की PDF चुनें।"});
   const source=await pdfText(files.source[0]);
   if(source.length<150) return res.status(400).json({error:"PDF से पर्याप्त टेक्स्ट नहीं निकला। स्कैन की गई PDF के लिए OCR आवश्यक हो सकता है।"});
   const data=await askAI(
    "You create very difficult Indian civil-service preliminary exam MCQs from supplied source text. Return only JSON: {questions:[{number,question,options:[four strings labelled A)...D)],answer:'A|B|C|D',explanation,topic}]}. Questions must be answerable from the source, tricky but unambiguous, cover facts/concepts/exceptions, never invent source facts. Hindi language. Generate up to 100 high-quality questions based on available text; do not force 100 if source is short.",
    "Create difficult, source-grounded MCQs from this material. Use exactly four options. Source text:\n"+source.slice(0,90000),14000);
   const rows=normalizeQuestions(data.questions, "", "AI source", date);
   if(!rows.length) return res.status(422).json({error:"इस PDF से वैध प्रश्न नहीं बन पाए।"});
   const batchId=insertQuestions(rows,"AI प्रश्न — "+date);
   return res.json({ok:true,added:rows.length,batchId,ambiguous:[],message:"AI से बने प्रश्न प्रश्न-बैंक में जोड़ दिए गए।"});
  }
  if(!files.questions?.[0]||!files.answerKey?.[0]) return res.status(400).json({error:"प्रश्न PDF और उत्तर-कुंजी PDF दोनों चुनें।"});
  const qText=await pdfText(files.questions[0]), aText=await pdfText(files.answerKey[0]);
  if(qText.length<100||aText.length<10) return res.status(400).json({error:"PDF से टेक्स्ट नहीं निकला। स्कैन PDF को पहले OCR से टेक्स्ट योग्य बनाएँ।"});
  const parsed=await askAI(
   "Extract multiple-choice questions faithfully from text. Return JSON {questions:[{number,question,options:[four strings labelled A)...D)],topic}]}. Preserve question numbering and Hindi wording. Do not invent missing text. Only include clearly readable questions. If fewer than four options are visible, include only if the question remains clear and flag by adding 'needs_review':true.",
   "Extract all readable MCQs from this question paper. Text:\n"+qText.slice(0,90000),14000);
  const key=await askAI(
   "Extract answer keys. Return JSON {answers:[{number,answer:'A|B|C|D',explanation:''}]}. Preserve question number and exact answer letter. If unclear, set answer to empty string. Do not guess.",
   "Extract the answer key from this text:\n"+aText.slice(0,40000),5000);
  const answerMap=new Map((key.answers||[]).map(x=>[Number(x.number),String(x.answer||"").trim().toUpperCase()]));
  const raw=(parsed.questions||[]);
  const ambiguous=[];
  const merged=raw.map((q,i)=>{
   const n=Number(q.number||i+1), ans=answerMap.get(n)||"";
   const valid=["A","B","C","D"].includes(ans);
   if(!valid||q.needs_review) ambiguous.push({number:n,question:q.question||"",reason:!valid?"उत्तर-कुंजी में स्पष्ट मिलान नहीं मिला।":"प्रश्न का कुछ भाग अस्पष्ट है।",options:q.options||[],answer:valid?ans:"",explanation:""});
   return {...q,number:n,answer:valid?ans:"",explanation:""};
  });
  // Store parsed draft in response for user confirmation; nothing is committed until confirmation.
  return res.json({ok:true,needsConfirmation:true,label:files.questions[0].originalname,questions:merged,ambiguous,matched:merged.filter(q=>["A","B","C","D"].includes(q.answer)).length,answerKeyCount:(key.answers||[]).length});
 }catch(e){
  console.error(e);
  const msg=e.message==="AI_API_MISSING"?"AI कनेक्शन सेट नहीं है। होस्टिंग के Environment में OPENAI_API_KEY जोड़ें।":(e.message||"PDF प्रोसेस नहीं हो सकी।");
  res.status(500).json({error:msg});
 }finally{
  Object.values(files).flat().forEach(f=>{try{fs.unlinkSync(f.path)}catch{}});
 }
});
app.post("/api/import-confirm",auth,(req,res)=>{
 const {questions,label,sourceDate}=req.body||{};
 if(!Array.isArray(questions)||!questions.length) return res.status(400).json({error:"जोड़ने के लिए प्रश्न नहीं हैं।"});
 const clean=questions.filter(q=>q.include!==false && ["A","B","C","D"].includes(String(q.answer||"").toUpperCase()));
 const rows=normalizeQuestions(clean,"","question paper",String(sourceDate||today()));
 if(!rows.length) return res.status(400).json({error:"कोई वैध प्रश्न और उत्तर नहीं मिला।"});
 const batchId=insertQuestions(rows,String(label||"अपलोड किया गया टेस्ट")+" — "+today());
 res.json({ok:true,added:rows.length,batchId});
});
app.get("/api/test",auth,(req,res)=>{
 const type=String(req.query.type||"new"), name=req.user.name, day=today();
 let rows=[], label="", maxScore=0;
 const all=db.prepare("SELECT * FROM questions WHERE answer IS NOT NULL ORDER BY source_date DESC,id DESC").all();
 const recent10=all.filter(q=>q.source_date>=new Date(Date.now()-9*86400000).toISOString().slice(0,10));
 const old=all.filter(q=>q.source_date<new Date(Date.now()-9*86400000).toISOString().slice(0,10));
 const last30=all.filter(q=>q.source_date>=new Date(Date.now()-29*86400000).toISOString().slice(0,10));
 const lowAttempts=db.prepare("SELECT question_ids,percent FROM attempts WHERE user_name=? AND percent<=90 ORDER BY id DESC LIMIT 20").all(name);
 const repeatIds=new Set();
 lowAttempts.forEach(a=>{try{JSON.parse(a.question_ids).forEach(id=>repeatIds.add(id))}catch{}});
 const repeated=all.filter(q=>repeatIds.has(q.id));
 if(type==="daily1"||type==="daily2"){
  const saved=db.prepare("SELECT question_ids FROM daily_sessions WHERE user_name=? AND day=? AND section=?").get(name,day,type);
  if(saved){
   const ids=JSON.parse(saved.question_ids);
   rows=ids.map(id=>db.prepare("SELECT * FROM questions WHERE id=?").get(id)).filter(Boolean);
   // If more questions are uploaded later the same day, fill any remaining slots without repeating questions across sections.
   if(rows.length<100){
    const already=db.prepare("SELECT question_ids FROM daily_sessions WHERE user_name=? AND day=?").all(name,day);
    const used=new Set(); already.forEach(x=>{try{JSON.parse(x.question_ids).forEach(id=>used.add(id))}catch{}});
    const pool=shuffle([...recent10.filter(q=>!repeated.some(r=>r.id===q.id)),...repeated,...old].filter(q=>!used.has(q.id)));
    const additions=pool.slice(0,100-rows.length);
    rows=rows.concat(additions);
    db.prepare("UPDATE daily_sessions SET question_ids=? WHERE user_name=? AND day=? AND section=?").run(JSON.stringify(rows.map(q=>q.id)),name,day,type);
   }
  } else {
   const already=db.prepare("SELECT question_ids FROM daily_sessions WHERE user_name=? AND day=?").all(name,day);
   const used=new Set(); already.forEach(x=>{try{JSON.parse(x.question_ids).forEach(id=>used.add(id))}catch{}});
   const pool=shuffle([...recent10.filter(q=>!repeated.some(r=>r.id===q.id)),...repeated,...old].filter(q=>!used.has(q.id)));
   rows=pool.slice(0,100);
   db.prepare("INSERT INTO daily_sessions(user_name,day,section,question_ids) VALUES(?,?,?,?)").run(name,day,type,JSON.stringify(rows.map(q=>q.id)));
  }
  label=type==="daily1"?"दैनिक टास्क — सेक्शन 1":"दैनिक टास्क — सेक्शन 2"; maxScore=200;
 } else if(type==="sunday"){
  rows=shuffle(last30).slice(0,200); label="रविवार विशेष टेस्ट"; maxScore=500;
 } else if(type==="old"){
  rows=shuffle(old).slice(0,100); label="Old Topic"; maxScore=200;
 } else if(type==="new"){
  rows=shuffle(recent10).slice(0,100); label="New Test"; maxScore=200;
 } else if(type.startsWith("batch:")){
  const bid=type.slice(6);
  rows=all.filter(q=>q.batch_id===bid).sort((a,b)=>a.qno-b.qno);
  label=db.prepare("SELECT label FROM batches WHERE id=?").get(bid)?.label||"टेस्ट";
  maxScore=rows.length*2;
 } else { return res.status(400).json({error:"अज्ञात टेस्ट प्रकार।"}); }
 const questions=rows.map(publicQuestion);
 res.json({type,label,questions,maxScore,marking:type==="sunday"?{correct:2.5,wrong:-5/6,blank:0}:{correct:2,wrong:-2/3,blank:0},available:questions.length});
});
app.post("/api/submit",auth,(req,res)=>{
 const {type,label,questionIds,answers,durationSeconds}=req.body||{};
 if(!Array.isArray(questionIds)||!Array.isArray(answers)||questionIds.length!==answers.length||!questionIds.length) return res.status(400).json({error:"टेस्ट डेटा सही नहीं है।"});
 const sunday=type==="sunday", correctMark=sunday?2.5:2, wrongMark=sunday?-(5/6):-(2/3);
 const rows=questionIds.map(id=>db.prepare("SELECT id,answer FROM questions WHERE id=?").get(id));
 let correct=0,wrong=0,skipped=0;
 rows.forEach((q,i)=>{const a=String(answers[i]||"").toUpperCase();if(!a){skipped++;}else if(q&&a===q.answer){correct++;}else{wrong++;}});
 const score=correct*correctMark+wrong*wrongMark, maxScore=questionIds.length*correctMark, percent=Math.max(0,Math.min(100,score/maxScore*100));
 const completedAt=new Date().toISOString(), dailyDate=(type==="daily1"||type==="daily2")?today():null;
 db.prepare(`INSERT INTO attempts(user_name,test_type,test_label,question_ids,answers,correct,wrong,skipped,score,max_score,percent,duration_seconds,completed_at,daily_date)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.user.name,type,String(label||type),JSON.stringify(questionIds),JSON.stringify(answers),correct,wrong,skipped,score,maxScore,percent,Number(durationSeconds||0),completedAt,dailyDate);
 let dailyComplete=false,pointsAwarded=0;
 if(type==="daily1"||type==="daily2"){
  const completed=db.prepare("SELECT test_type FROM attempts WHERE user_name=? AND daily_date=? AND test_type IN ('daily1','daily2')").all(req.user.name,today());
  if(completed.some(x=>x.test_type==="daily1")&&completed.some(x=>x.test_type==="daily2")){
   const exists=db.prepare("SELECT 1 FROM daily_completions WHERE user_name=? AND day=?").get(req.user.name,today());
   if(!exists){db.prepare("INSERT INTO daily_completions(user_name,day,points) VALUES(?,?,1)").run(req.user.name,today());pointsAwarded=1;}
   dailyComplete=true;
  }
 }
 const review=questionIds.map((id,i)=>{const q=db.prepare("SELECT id,question,options,answer,explanation FROM questions WHERE id=?").get(id);return {id,given:answers[i]||"",correct:q?.answer||null,question:q?.question||"",options:q?JSON.parse(q.options):[],explanation:q?.explanation||""};});
 res.json({correct,wrong,skipped,score:Number(score.toFixed(2)),maxScore:Number(maxScore.toFixed(2)),percent:Number(percent.toFixed(2)),durationSeconds:Number(durationSeconds||0),completedAt,stars:percent>98?5:percent>=90?4:3,verdict:percent>98?"Best":percent>=90?"Very Good":"Bad",dailyComplete,pointsAwarded,answers:review});
});
app.get("/api/review/:attemptId",auth,(req,res)=>{
 const a=db.prepare("SELECT * FROM attempts WHERE id=? AND user_name=?").get(Number(req.params.attemptId),req.user.name);
 if(!a)return res.status(404).json({error:"रिकॉर्ड नहीं मिला।"});
 const ids=JSON.parse(a.question_ids), answers=JSON.parse(a.answers);
 const qs=ids.map((id,i)=>{const q=db.prepare("SELECT * FROM questions WHERE id=?").get(id);return q?{...publicQuestion(q),answer:q.answer,explanation:q.explanation,given:answers[i]||""}:null;}).filter(Boolean);
 res.json({attempt:a,questions:qs});
});
app.get("/api/attempts",auth,(req,res)=>{
 res.json(db.prepare("SELECT id,test_type,test_label,correct,wrong,skipped,score,max_score,percent,duration_seconds,completed_at FROM attempts WHERE user_name=? ORDER BY id DESC LIMIT 100").all(req.user.name));
});
app.get("*",(_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.use((err,_req,res,_next)=>{console.error(err);res.status(400).json({error:err.message||"अनुरोध पूरा नहीं हुआ।"});});
app.listen(PORT,()=>console.log("Revision Target running on port "+PORT));
