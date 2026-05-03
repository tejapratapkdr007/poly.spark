const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { MongoClient } = require("mongodb");
const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// =====================================================
// MONGODB PERSISTENCE (works on Render free plan)
// =====================================================
const MONGO_URI = process.env.MONGO_URI;
let db = null;

async function connectDB() {
    if (!MONGO_URI) {
        console.warn("⚠️  No MONGO_URI set — using in-memory only (data lost on restart)");
        return;
    }
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db("polyspark");
        console.log("✅ MongoDB connected");
    } catch (e) {
        console.error("❌ MongoDB connection failed:", e.message);
    }
}

async function loadData() {
    if (!db) return {};
    try {
        const doc = await db.collection("appdata").findOne({ _id: "main" });
        return doc || {};
    } catch (e) { console.error("Load data error:", e.message); return {}; }
}

async function saveData() {
    if (!db) return;
    try {
        await db.collection("appdata").updateOne(
            { _id: "main" },
            { $set: {
                questions, studentAnswers, mediaFiles, studentPhones,
                bulkSchedule, studentScores, studentStreaks,
                wordItems, affairsItems,
                mediaSchedule, wordSchedule, affairsSchedule,
                speakingTopics, speakingReports
            }},
            { upsert: true }
        );
    } catch (e) { console.error("Save data error:", e.message); }
}

// Auto-save every 30 seconds
setInterval(saveData, 30000);

// =====================================================
// BOOT — connect DB then start server
// =====================================================
let questions = [], studentAnswers = [], mediaFiles = [], studentPhones = {};
let bulkSchedule = null, studentScores = {}, studentStreaks = {};
let wordItems = [], affairsItems = [];
let mediaSchedule = null, wordSchedule = null, affairsSchedule = null;
let speakingTopics = [], speakingReports = [];

async function boot() {
    await connectDB();
    const saved = await loadData();
    questions       = saved.questions       || [];
    studentAnswers  = saved.studentAnswers  || [];
    mediaFiles      = saved.mediaFiles      || [];
    studentPhones   = saved.studentPhones   || {};
    bulkSchedule    = saved.bulkSchedule    || null;
    studentScores   = saved.studentScores   || {};
    studentStreaks   = saved.studentStreaks  || {};
    wordItems       = saved.wordItems       || [];
    affairsItems    = saved.affairsItems    || [];
    mediaSchedule   = saved.mediaSchedule   || null;
    wordSchedule    = saved.wordSchedule    || null;
    affairsSchedule = saved.affairsSchedule || null;
    speakingTopics  = saved.speakingTopics  || [];
    speakingReports = saved.speakingReports || [];
    console.log(`✅ Data loaded: ${questions.length} questions, ${studentAnswers.length} answers, ${Object.keys(studentPhones).length} students`);
}

// =====================================================
// BULK SCHEDULE
// =====================================================
app.get("/schedule", (req, res) => {
    res.json(bulkSchedule || { empty: true });
});

app.post("/schedule", (req, res) => {
    const { schedule } = req.body;
    if (!schedule) return res.status(400).json({ error: "Schedule required" });
    bulkSchedule = schedule;
    saveData();
    res.json({ success: true, schedule: bulkSchedule });
});

app.delete("/schedule", (req, res) => {
    bulkSchedule = null;
    saveData();
    res.json({ success: true });
});

app.post("/schedule/mark-posted", (req, res) => {
    const { index, postedAt } = req.body;
    if (!bulkSchedule || !bulkSchedule.questions || index === undefined)
        return res.status(400).json({ error: "Invalid request" });
    if (bulkSchedule.questions[index]) {
        bulkSchedule.questions[index].posted = true;
        bulkSchedule.questions[index].postedAt = postedAt || new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
        bulkSchedule.lastAutoPost = {
            question: bulkSchedule.questions[index].question.substring(0, 50) + "...",
            time: bulkSchedule.questions[index].postedAt,
            day: index + 1
        };
    }
    saveData();
    res.json({ success: true, schedule: bulkSchedule });
});

// =====================================================
// SCORES
// =====================================================
app.get("/scores", (req, res) => res.json({ scores: studentScores, streaks: studentStreaks }));

app.post("/scores", (req, res) => {
    const { pin, name, points, date } = req.body;
    if (!pin || !name || points == null || !date) return res.status(400).json({ error: "All fields required" });
    if (!studentScores[pin]) studentScores[pin] = { name, scores: [] };
    studentScores[pin].name = name;
    const existingScore = studentScores[pin].scores.find(s => s.date === date);
    if (existingScore) {
        existingScore.points += points;
    } else {
        studentScores[pin].scores.push({ date, points });
    }
    if (!studentStreaks[pin]) {
        studentStreaks[pin] = { count: 1, lastDate: date };
    } else {
        const last = studentStreaks[pin].lastDate;
        const diff = Math.round(Math.abs(new Date(date) - new Date(last)) / (1000 * 60 * 60 * 24));
        if (diff === 0) { }
        else if (diff === 1) { studentStreaks[pin].count += 1; studentStreaks[pin].lastDate = date; }
        else { studentStreaks[pin].count = 1; studentStreaks[pin].lastDate = date; }
    }
    saveData();
    res.json({ success: true });
});

// =====================================================
// QUESTIONS
// =====================================================
app.get("/questions", (req, res) => res.json(questions));

app.post("/questions", (req, res) => {
    const { question, answer, answerOpinion, questionFile, questionFileType } = req.body;
    if (!question) return res.status(400).json({ error: "Question is required" });

    // Save attached image/audio to disk if provided
    let fileUrl = null;
    if (questionFile && questionFileType) {
        try {
            const base64Data = questionFile.includes(',') ? questionFile.split(',')[1] : questionFile;
            const ext = questionFileType === 'audio' ? 'mp3' : 'jpg';
            const uniqueName = `gk_${Date.now()}.${ext}`;
            const filePath = path.join(UPLOADS_DIR, uniqueName);
            fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
            fileUrl = `/uploads/${uniqueName}`;
        } catch(e) {
            console.error('GK file save error:', e.message);
        }
    }

    const newQuestion = {
        id: Date.now(), question,
        answer: (answer && answer.trim()) ? answer.trim() : null,
        answerOpinion: answerOpinion || null,
        questionFile: fileUrl || (questionFile && questionFile.length < 500000 ? questionFile : null),
        questionFileType: questionFileType || null,
        date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
    };
    questions.push(newQuestion);
    saveData();
    res.json({ success: true, message: "Question posted successfully", question: newQuestion });
});

// Literal routes BEFORE parameterized /:id routes
app.delete("/questions/reset", (req, res) => { questions = []; saveData(); res.json({ success: true }); });

app.get("/questions/:id", (req, res) => {
    const q = questions.find(q => q.id === parseInt(req.params.id));
    q ? res.json(q) : res.status(404).json({ error: "Question not found" });
});

const setAnswer = (req, res) => {
    const { answer } = req.body;
    const q = questions.find(q => q.id === parseInt(req.params.id));
    if (!q) return res.status(404).json({ error: "Question not found" });
    if (!answer || !answer.trim()) return res.status(400).json({ error: "Answer is required" });
    q.answer = answer.trim();
    saveData();
    res.json({ success: true, question: q });
};
app.put("/questions/:id/answer", setAnswer);
app.post("/questions/:id/answer", setAnswer);

// =====================================================
// ANSWERS
// =====================================================
app.get("/answers", (req, res) => res.json(studentAnswers));

app.get("/answers/question/:questionId", (req, res) => {
    res.json(studentAnswers.filter(a => a.questionId === parseInt(req.params.questionId)));
});

app.post("/answers", (req, res) => {
    const { questionId, studentPin, studentName, answer, type } = req.body;
    if (!questionId || !studentPin || !studentName || !answer)
        return res.status(400).json({ error: "All fields are required" });
    const existing = studentAnswers.find(a =>
        a.questionId === questionId && a.studentPin === studentPin &&
        (a.type || "question") === (type || "question")
    );
    if (existing) return res.status(400).json({ error: "You have already answered this" });
    const newAnswer = {
        id: Date.now(), questionId, studentPin, studentName, answer,
        type: type || "question",
        submittedAt: new Date().toISOString(),
        date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
    };
    studentAnswers.push(newAnswer);
    saveData();
    res.json({ success: true, message: "Answer submitted successfully", answer: newAnswer });
});

// =====================================================
// MEDIA
// =====================================================
// =====================================================
// MEDIA FILE STORAGE (saves files to disk)
// =====================================================
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

app.get("/media", (req, res) => res.json(mediaFiles));

app.post("/media", (req, res) => {
    const { type, data, fileName, opinion, expectedAnswer } = req.body;
    if (!type || !data || !fileName || !opinion)
        return res.status(400).json({ error: "All fields are required" });

    let fileUrl = null;
    try {
        // Save base64 data as actual file on disk
        const base64Data = data.includes(',') ? data.split(',')[1] : data;
        const ext = fileName.split('.').pop().toLowerCase() || (type === 'audio' ? 'mp3' : 'jpg');
        const uniqueName = `media_${Date.now()}.${ext}`;
        const filePath = path.join(UPLOADS_DIR, uniqueName);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        fileUrl = `/uploads/${uniqueName}`;
    } catch(e) {
        console.error('File save error:', e.message);
        // fallback: store base64 if file save fails
        fileUrl = null;
    }

    const newMedia = {
        id: Date.now(), type,
        data: fileUrl || data,   // use URL if saved, else base64
        fileUrl,
        fileName, opinion,
        expectedAnswer: expectedAnswer || null, explanation: null,
        date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
    };
    mediaFiles.push(newMedia);
    saveData();
    res.json({ success: true, media: newMedia });
});

// Literal routes BEFORE parameterized /:id routes
app.get("/media/latest", (req, res) => {
    mediaFiles.length > 0 ? res.json(mediaFiles[mediaFiles.length - 1]) : res.status(404).json({ error: "No media" });
});

// Media text post (for bulk media schedule) — must be before /media/:id
app.post("/media/text", (req, res) => {
    const { question, answer, caption, urlOrText, type: reqType } = req.body;
    if (!question) return res.status(400).json({ error: "Question required" });

    // Detect type from passed type field, or caption filename, or data prefix
    let type = reqType || 'text';
    if (!reqType) {
        if (caption && caption.match(/\.(jpg|jpeg|png|gif|webp)$/i)) type = 'image';
        else if (caption && caption.match(/\.(mp3|wav|ogg|m4a|aac)$/i)) type = 'audio';
        else if (urlOrText && urlOrText.startsWith('data:image')) type = 'image';
        else if (urlOrText && urlOrText.startsWith('data:audio')) type = 'audio';
    }

    let fileUrl = null;
    // Save base64 to disk if it looks like file data
    if (urlOrText && (urlOrText.startsWith('data:') || urlOrText.length > 200)) {
        try {
            const base64Data = urlOrText.includes(',') ? urlOrText.split(',')[1] : urlOrText;
            const ext = caption ? caption.split('.').pop().toLowerCase() : (type === 'audio' ? 'mp3' : 'jpg');
            const uniqueName = `media_${Date.now()}.${ext}`;
            const filePath = path.join(UPLOADS_DIR, uniqueName);
            fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
            fileUrl = `/uploads/${uniqueName}`;
        } catch(e) {
            console.error('File save error:', e.message);
        }
    }

    const newMedia = {
        id: Date.now(), type,
        data: urlOrText || '',   // keep full base64 — always works even after redeploy
        fileUrl,
        fileName: caption || 'Media Item',
        opinion: question, expectedAnswer: answer || null, explanation: null,
        date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
    };
    mediaFiles.push(newMedia); saveData();
    res.json({ success: true, media: newMedia });
});

app.post("/media/:id/explanation", (req, res) => {
    const m = mediaFiles.find(m => m.id === parseInt(req.params.id));
    if (!m) return res.status(404).json({ error: "Not found" });
    m.explanation = req.body.explanation;
    saveData();
    res.json({ success: true, media: m });
});

app.delete("/media/:id", (req, res) => {
    const idx = mediaFiles.findIndex(m => m.id === parseInt(req.params.id));
    idx !== -1 ? (mediaFiles.splice(idx, 1), saveData(), res.json({ success: true })) : res.status(404).json({ error: "Not found" });
});

// =====================================================
// PHONES
// =====================================================
app.get("/phones", (req, res) => res.json(studentPhones));

app.post("/phones", (req, res) => {
    const { pin, name, phone } = req.body;
    if (!pin || !name || !phone) return res.status(400).json({ error: "All fields required" });
    studentPhones[pin] = { name, phone, lastLogin: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) };
    saveData();
    res.json({ success: true });
});

// =====================================================
// STATS / HEALTH
// =====================================================
app.get("/stats", (req, res) => res.json({
    totalQuestions: questions.length,
    totalAnswers: studentAnswers.length,
    totalMedia: mediaFiles.length,
    totalStudents: Object.keys(studentPhones).length,
    uniqueStudents: [...new Set(studentAnswers.map(a => a.studentPin))].length,
    latestQuestionDate: questions.length > 0 ? questions[questions.length - 1].date : null,
    questionAnswers: studentAnswers.filter(a => (!a.type || a.type === "question")).length,
    mediaAnswers: studentAnswers.filter(a => a.type === "media").length
}));

app.get("/health", (req, res) => res.json({ status: "OK", timestamp: new Date().toISOString(), uptime: process.uptime() }));

app.get("/api", (req, res) => res.json({ message: "TEJAPRATAP QUIZ API v5.0", status: "running" }));

// =====================================================
// TEACHER AUTH — password verified server-side only
// =====================================================
app.post("/admin/verify-teacher", (req, res) => {
    const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || '11223344@Ttp#';
    if (!TEACHER_PASSWORD) return res.status(500).json({ error: "Teacher password not configured on server" });
    if (req.body.password !== TEACHER_PASSWORD) return res.status(403).json({ success: false, error: "Wrong password" });
    res.json({ success: true });
});

app.post("/admin/reset-all", (req, res) => {
    const ADMIN_PASSWORD = process.env.ADMIN_RESET_PASSWORD || '11223344@Ttp#';
    if (!ADMIN_PASSWORD) return res.status(500).json({ error: "Admin password not configured on server" });
    if (req.body.confirmPassword !== ADMIN_PASSWORD) return res.status(403).json({ error: "Wrong password" });
    questions = []; studentAnswers = []; mediaFiles = []; studentPhones = {};
    bulkSchedule = null; studentScores = {}; studentStreaks = {};
    wordItems = []; affairsItems = []; mediaSchedule = null; wordSchedule = null; affairsSchedule = null;
    speakingTopics = []; speakingReports = [];
    saveData();
    res.json({ success: true, message: "All data reset" });
});

// =====================================================
// MEDIA SCHEDULE (separate from /schedule)
// =====================================================
app.get("/schedule/media", (req, res) => res.json(mediaSchedule || { empty: true }));
app.post("/schedule/media", (req, res) => { const { schedule } = req.body; if (!schedule) return res.status(400).json({ error: "Schedule required" }); mediaSchedule = schedule; saveData(); res.json({ success: true }); });
app.delete("/schedule/media", (req, res) => { mediaSchedule = null; saveData(); res.json({ success: true }); });
app.post("/schedule/media/mark-posted", (req, res) => {
    const { index, postedAt } = req.body;
    if (!mediaSchedule || !mediaSchedule.items || index === undefined) return res.status(400).json({ error: "Invalid" });
    if (mediaSchedule.items[index]) {
        mediaSchedule.items[index].posted = true;
        mediaSchedule.items[index].postedAt = postedAt || new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
        mediaSchedule.lastAutoPost = { day: index + 1, time: mediaSchedule.items[index].postedAt };
    }
    saveData(); res.json({ success: true });
});

// Set/update media expected answer
const setMediaAnswer = (req, res) => {
    const { expectedAnswer } = req.body;
    const m = mediaFiles.find(m => m.id === parseInt(req.params.id));
    if (!m) return res.status(404).json({ error: "Not found" });
    m.expectedAnswer = expectedAnswer;
    saveData(); res.json({ success: true, media: m });
};
app.put("/media/:id/answer", setMediaAnswer);
app.post("/media/:id/answer", setMediaAnswer);

// =====================================================
// WORD OF THE DAY
// =====================================================
app.get("/word", (req, res) => res.json(wordItems));

app.post("/word", (req, res) => {
    const { word, question, answer } = req.body;
    if (!word || !question) return res.status(400).json({ error: "Word and question required" });
    const item = { id: Date.now(), word, question, answer: (answer && answer.trim()) ? answer.trim() : null, date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) };
    wordItems.push(item); saveData();
    res.json({ success: true, item });
});

const setWordAnswer = (req, res) => {
    const { answer } = req.body;
    const w = wordItems.find(w => w.id === parseInt(req.params.id));
    if (!w) return res.status(404).json({ error: "Not found" });
    if (!answer || !answer.trim()) return res.status(400).json({ error: "Answer required" });
    w.answer = answer.trim(); saveData();
    res.json({ success: true, item: w });
};
app.put("/word/:id/answer", setWordAnswer);
app.post("/word/:id/answer", setWordAnswer);

app.get("/schedule/word", (req, res) => res.json(wordSchedule || { empty: true }));
app.post("/schedule/word", (req, res) => { const { schedule } = req.body; if (!schedule) return res.status(400).json({ error: "Required" }); wordSchedule = schedule; saveData(); res.json({ success: true }); });
app.delete("/schedule/word", (req, res) => { wordSchedule = null; saveData(); res.json({ success: true }); });
app.post("/schedule/word/mark-posted", (req, res) => {
    const { index, postedAt } = req.body;
    if (!wordSchedule || !wordSchedule.words || index === undefined) return res.status(400).json({ error: "Invalid" });
    if (wordSchedule.words[index]) {
        wordSchedule.words[index].posted = true;
        wordSchedule.words[index].postedAt = postedAt || new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
        wordSchedule.lastAutoPost = { day: index + 1, time: wordSchedule.words[index].postedAt };
    }
    saveData(); res.json({ success: true });
});

// =====================================================
// CURRENT AFFAIRS
// =====================================================
app.get("/affairs", (req, res) => res.json(affairsItems));

app.post("/affairs", (req, res) => {
    const { question, answer } = req.body;
    if (!question) return res.status(400).json({ error: "Question required" });
    const item = { id: Date.now(), question, answer: (answer && answer.trim()) ? answer.trim() : null, date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) };
    affairsItems.push(item); saveData();
    res.json({ success: true, item });
});

const setAffairsAnswer = (req, res) => {
    const { answer } = req.body;
    const a = affairsItems.find(a => a.id === parseInt(req.params.id));
    if (!a) return res.status(404).json({ error: "Not found" });
    if (!answer || !answer.trim()) return res.status(400).json({ error: "Answer required" });
    a.answer = answer.trim(); saveData();
    res.json({ success: true, item: a });
};
app.put("/affairs/:id/answer", setAffairsAnswer);
app.post("/affairs/:id/answer", setAffairsAnswer);

app.get("/schedule/affairs", (req, res) => res.json(affairsSchedule || { empty: true }));
app.post("/schedule/affairs", (req, res) => { const { schedule } = req.body; if (!schedule) return res.status(400).json({ error: "Required" }); affairsSchedule = schedule; saveData(); res.json({ success: true }); });
app.delete("/schedule/affairs", (req, res) => { affairsSchedule = null; saveData(); res.json({ success: true }); });
app.post("/schedule/affairs/mark-posted", (req, res) => {
    const { index, postedAt } = req.body;
    if (!affairsSchedule || !affairsSchedule.questions || index === undefined) return res.status(400).json({ error: "Invalid" });
    if (affairsSchedule.questions[index]) {
        affairsSchedule.questions[index].posted = true;
        affairsSchedule.questions[index].postedAt = postedAt || new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
        affairsSchedule.lastAutoPost = { day: index + 1, time: affairsSchedule.questions[index].postedAt };
    }
    saveData(); res.json({ success: true });
});

// =====================================================
// SPEAKING TOPICS
// =====================================================
app.get("/speaking", (req, res) => res.json(speakingTopics));

app.post("/speaking", (req, res) => {
    const { topic, duration, date } = req.body;
    if (!topic || !duration) return res.status(400).json({ error: "Topic and duration required" });
    const item = {
        id: Date.now(), topic, duration: parseInt(duration) || 3,
        date: date || new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
        active: true
    };
    speakingTopics.forEach(t => t.active = false);
    speakingTopics.push(item);
    saveData();
    res.json({ success: true, item });
});

app.delete("/speaking/:id", (req, res) => {
    const idx = speakingTopics.findIndex(t => t.id === parseInt(req.params.id));
    if (idx !== -1) { speakingTopics.splice(idx, 1); saveData(); res.json({ success: true }); }
    else res.status(404).json({ error: "Not found" });
});

app.put("/speaking/:id/activate", (req, res) => {
    speakingTopics.forEach(t => t.active = false);
    const t = speakingTopics.find(t => t.id === parseInt(req.params.id));
    if (!t) return res.status(404).json({ error: "Not found" });
    t.active = true; saveData();
    res.json({ success: true, item: t });
});

// =====================================================
// GRAMMAR ANALYZER (Rule-Based — No API Key Needed)
// =====================================================

// Student submits speaking report after analysis
app.post("/speaking/report", (req, res) => {
    const { name, pin, transcript, topic, score, wordCount, errors, feedback, time } = req.body;
    if (!transcript) return res.status(400).json({ error: "Transcript required" });
    const report = { id: Date.now(), name: name||'Unknown', pin: pin||'', transcript, topic: topic||'', score: score||0, wordCount: wordCount||0, errors: errors||[], feedback: feedback||'', time: time||Date.now() };
    speakingReports.unshift(report);
    if (speakingReports.length > 200) speakingReports = speakingReports.slice(0, 200); // keep last 200
    saveData();
    res.json({ success: true });
});

// Teacher fetches all student speaking reports
app.get("/speaking/reports", (req, res) => {
    res.json(speakingReports);
});
function analyzeGrammar(text) {
    if (!text || !text.trim()) return { errors: [], score: 0, feedback: "No text provided." };

    const errors = [];

    const check = (pattern, getCorrect, type, explanation) => {
        const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
        let m;
        while ((m = re.exec(text)) !== null) {
            const wrong = m[0];
            const corrected = getCorrect(m);
            if (wrong.toLowerCase() !== corrected.toLowerCase()) {
                errors.push({ wrong, corrected, type, explanation });
            }
        }
    };

    // ── SUBJECT-VERB AGREEMENT (he/she/it + base verb) ──
    const singular = ['he','she','it'];
    const svPairs = [
        ['go','goes'],['have','has'],['do','does'],['come','comes'],['run','runs'],
        ['make','makes'],['take','takes'],['get','gets'],['give','gives'],['think','thinks'],
        ['know','knows'],['see','sees'],['say','says'],['want','wants'],['work','works'],
        ['live','lives'],['play','plays'],['study','studies'],['write','writes'],
        ['speak','speaks'],['learn','learns'],['teach','teaches'],['watch','watches'],
        ['eat','eats'],['drink','drinks'],['help','helps'],['try','tries'],['use','uses'],
        ['start','starts'],['show','shows'],['need','needs'],['feel','feels'],['mean','means'],
        ['seem','seems'],['become','becomes'],['leave','leaves'],['move','moves'],
        ['pay','pays'],['keep','keeps'],['put','puts'],['hold','holds'],['buy','buys'],
        ['bring','brings'],['stand','stands'],['lose','loses'],['win','wins'],['build','builds'],
        ['stay','stays'],['fall','falls'],['open','opens'],['walk','walks'],['talk','talks'],
        ['ask','asks'],['tell','tells'],['turn','turns'],['reach','reaches'],['remember','remembers'],
        ['decide','decides'],['meet','meets'],['enjoy','enjoys'],['prefer','prefers'],
        ['understand','understands'],['explain','explains'],['happen','happens'],['continue','continues'],
        ['complete','completes'],['include','includes'],['contain','contains'],['involve','involves'],
        ['exist','exists'],['appear','appears'],['remain','remains'],['follow','follows'],
        ['pass','passes'],['spend','spends'],['begin','begins'],['increase','increases'],
        ['add','adds'],['change','changes'],['develop','develops'],['provide','provides'],
        ['create','creates'],['support','supports'],['allow','allows'],['consider','considers'],
        ['compare','compares'],['produce','produces'],['collect','collects'],['serve','serves'],
    ];
    svPairs.forEach(([base, third]) => {
        const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        check(new RegExp(`\\b(he|she|it)\\s+(${escapedBase})\\b`, 'gi'),
            m => `${m[1]} ${third}`, 'Subject-Verb Agreement',
            `"${base}" → "${third}" after he/she/it`);
    });

    // he/she/it + are
    check(/\b(he|she|it)\s+are\b/gi, m => `${m[1]} is`, 'Subject-Verb Agreement', '"are" → "is" after he/she/it');
    // they/we/you + is
    check(/\b(they|we|you)\s+is\b/gi, m => `${m[1]} are`, 'Subject-Verb Agreement', '"is" → "are" after they/we/you');
    // I + are
    check(/\bi\s+are\b/gi, () => 'I am', 'Subject-Verb Agreement', '"are" → "am" after I');
    // I/we/you/they + was
    check(/\b(I|i|we|We|you|You|they|They)\s+was\b/g, m => {
        const subj = m[1]; const cap = subj[0] === subj[0].toUpperCase();
        const base = subj.toLowerCase();
        const correct = base === 'i' ? 'I' : (cap ? subj[0].toUpperCase() + subj.slice(1) : subj);
        return `${correct} were`;
    }, 'Subject-Verb Agreement', '"was" → "were" after I/we/you/they');
    // he/she/it + were (not conditional)
    check(/\b(he|she|it)\s+were\b(?!\s+to\b)/gi, m => `${m[1]} was`, 'Subject-Verb Agreement', '"were" → "was" after he/she/it');
    // he/she/it + don't
    check(/\b(he|she|it)\s+don't\b/gi, m => `${m[1]} doesn't`, 'Auxiliary Verb Error', '"don\'t" → "doesn\'t" after he/she/it');
    // he/she/it + don't (no apostrophe)
    check(/\b(he|she|it)\s+dont\b/gi, m => `${m[1]} doesn't`, 'Auxiliary Verb Error', '"dont" → "doesn\'t" after he/she/it');
    // he/she/it + didn't + verb → OK, but: he/she/it + do not + verb
    check(/\b(he|she|it)\s+do\s+not\b/gi, m => `${m[1]} does not`, 'Auxiliary Verb Error', '"do not" → "does not" after he/she/it');

    // ── TENSE / IRREGULAR VERB ERRORS ──
    const irregularErrors = [
        [/\bgoed\b/gi, 'went', 'Tense Error', '"goed" is incorrect; use "went" (past of go)'],
        [/\bcomed\b/gi, 'came', 'Tense Error', '"comed" is not a word; use "came"'],
        [/\brunned\b/gi, 'ran', 'Tense Error', '"runned" is incorrect; use "ran"'],
        [/\btaked\b/gi, 'took', 'Tense Error', '"taked" is incorrect; use "took"'],
        [/\bteached\b/gi, 'taught', 'Tense Error', '"teached" is incorrect; use "taught"'],
        [/\bbuyed\b/gi, 'bought', 'Tense Error', '"buyed" is incorrect; use "bought"'],
        [/\bsayed\b/gi, 'said', 'Tense Error', '"sayed" is incorrect; use "said"'],
        [/\bthought\b/gi, null, null, null], // correct - skip
        [/\bthinkted\b/gi, 'thought', 'Tense Error', '"thinkted" is incorrect; use "thought"'],
        [/\bputted\b/gi, 'put', 'Tense Error', '"putted" is incorrect; use "put"'],
        [/\bcutted\b/gi, 'cut', 'Tense Error', '"cutted" is incorrect; use "cut"'],
        [/\bhitted\b/gi, 'hit', 'Tense Error', '"hitted" is incorrect; use "hit"'],
        [/\bleftted\b/gi, 'left', 'Tense Error', '"leftted" is incorrect; use "left"'],
        [/\bsleeped\b/gi, 'slept', 'Tense Error', '"sleeped" is incorrect; use "slept"'],
        [/\bfeeled\b/gi, 'felt', 'Tense Error', '"feeled" is incorrect; use "felt"'],
        [/\bfinded\b/gi, 'found', 'Tense Error', '"finded" is incorrect; use "found"'],
        [/\bgived\b/gi, 'gave', 'Tense Error', '"gived" is incorrect; use "gave"'],
        [/\bkeeped\b/gi, 'kept', 'Tense Error', '"keeped" is incorrect; use "kept"'],
        [/\bknowed\b/gi, 'knew', 'Tense Error', '"knowed" is incorrect; use "knew"'],
        [/\bmaked\b/gi, 'made', 'Tense Error', '"maked" is incorrect; use "made"'],
        [/\bseened\b/gi, 'saw', 'Tense Error', '"seened" is incorrect; use "saw"'],
        [/\bwinned\b/gi, 'won', 'Tense Error', '"winned" is incorrect; use "won"'],
        [/\bwrited\b/gi, 'wrote', 'Tense Error', '"writed" is incorrect; use "wrote"'],
        [/\bdrove\b/gi, null, null, null], // correct
        [/\bdrived\b/gi, 'drove', 'Tense Error', '"drived" is incorrect; use "drove"'],
        [/\bbroken\b/gi, null, null, null], // correct past participle
        [/\bbreaked\b/gi, 'broke', 'Tense Error', '"breaked" is incorrect; use "broke"'],
        [/\bspeaked\b/gi, 'spoke', 'Tense Error', '"speaked" is incorrect; use "spoke"'],
        [/\bstoled\b/gi, 'stole', 'Tense Error', '"stoled" is incorrect; use "stole"'],
        [/\bflied\b/gi, 'flew', 'Tense Error', '"flied" is incorrect; use "flew"'],
        [/\bgrowed\b/gi, 'grew', 'Tense Error', '"growed" is incorrect; use "grew"'],
        [/\bkilled\b/gi, null, null, null], // correct
        [/\bfallen\b/gi, null, null, null], // correct
        [/\bfalled\b/gi, 'fell', 'Tense Error', '"falled" is incorrect; use "fell"'],
        [/\bstanded\b/gi, 'stood', 'Tense Error', '"standed" is incorrect; use "stood"'],
        [/\bunderstandened\b/gi, 'understood', 'Tense Error', '"understandened" is incorrect; use "understood"'],
        [/\bunderstandied\b/gi, 'understood', 'Tense Error', '"understandied" is incorrect; use "understood"'],
        [/\bbringed\b/gi, 'brought', 'Tense Error', '"bringed" is incorrect; use "brought"'],
        [/\bchoosed\b/gi, 'chose', 'Tense Error', '"choosed" is incorrect; use "chose"'],
        [/\bcatched\b/gi, 'caught', 'Tense Error', '"catched" is incorrect; use "caught"'],
    ];
    irregularErrors.forEach(([re, fix, type, expl]) => {
        if (!fix) return;
        check(re, () => fix, type, expl);
    });

    // ── DOUBLE NEGATIVES ──
    const dnRules = [
        [/\bdon'?t\s+know\s+nothing\b/gi, "don't know anything", "Double Negative", '"don\'t know nothing" should be "don\'t know anything"'],
        [/\bcan'?t\s+do\s+nothing\b/gi, "can't do anything", "Double Negative", '"can\'t do nothing" → "can\'t do anything"'],
        [/\bwon'?t\s+go\s+nowhere\b/gi, "won't go anywhere", "Double Negative", '"won\'t go nowhere" → "won\'t go anywhere"'],
        [/\bain'?t\s+got\s+nothing\b/gi, "haven't got anything", "Double Negative", '"ain\'t got nothing" → "haven\'t got anything"'],
        [/\bdon'?t\s+have\s+nothing\b/gi, "don't have anything", "Double Negative", '"don\'t have nothing" → "don\'t have anything"'],
        [/\bcan'?t\s+find\s+nothing\b/gi, "can't find anything", "Double Negative", '"can\'t find nothing" → "can\'t find anything"'],
        [/\bwon'?t\s+say\s+nothing\b/gi, "won't say anything", "Double Negative", '"won\'t say nothing" → "won\'t say anything"'],
        [/\bdidn'?t\s+do\s+nothing\b/gi, "didn't do anything", "Double Negative", '"didn\'t do nothing" → "didn\'t do anything"'],
        [/\bnever\s+said\s+nothing\b/gi, "never said anything", "Double Negative", '"never said nothing" → "never said anything"'],
        [/\bno\s+one\s+didn'?t\b/gi, "no one did", "Double Negative", 'Avoid double negative with "no one" and "didn\'t"'],
    ];
    dnRules.forEach(([re, fix, type, expl]) => check(re, () => fix, type, expl));

    // ── PRONOUN ERRORS ──
    const pronounRules = [
        [/\bhim\s+is\b/gi, "he is", "Pronoun Error", '"him is" → "he is"'],
        [/\bher\s+is\b/gi, "she is", "Pronoun Error", '"her is" → "she is"'],
        [/\bhim\s+was\b/gi, "he was", "Pronoun Error", '"him was" → "he was"'],
        [/\bher\s+was\b/gi, "she was", "Pronoun Error", '"her was" → "she was"'],
        [/\bme\s+is\b/gi, "I am", "Pronoun Error", '"me is" → "I am"'],
        [/\bme\s+was\b/gi, "I was", "Pronoun Error", '"me was" → "I was"'],
        [/\bme\s+am\b/gi, "I am", "Pronoun Error", '"me am" → "I am"'],
        [/\bme\s+are\b/gi, "I am", "Pronoun Error", '"me are" → "I am"'],
        [/\bus\s+are\s+going\b/gi, "we are going", "Pronoun Error", '"us are going" → "we are going"'],
        [/\bthem\s+are\b/gi, "they are", "Pronoun Error", '"them are" → "they are"'],
        [/\bthem\s+is\b/gi, "they are", "Pronoun Error", '"them is" → "they are"'],
        [/\bbetween\s+he\s+and\b/gi, "between him and", "Pronoun Error", '"between he and" → "between him and"'],
        [/\bbetween\s+she\s+and\b/gi, "between her and", "Pronoun Error", '"between she and" → "between her and"'],
        [/\bbetween\s+I\s+and\b/gi, "between me and", "Pronoun Error", '"between I and" → "between me and"'],
        [/\bfor\s+I\b/gi, "for me", "Pronoun Error", '"for I" → "for me"'],
        [/\bwith\s+I\b/gi, "with me", "Pronoun Error", '"with I" → "with me"'],
        [/\bto\s+I\b/gi, "to me", "Pronoun Error", '"to I" → "to me"'],
    ];
    pronounRules.forEach(([re, fix, type, expl]) => check(re, () => fix, type, expl));

    // ── ARTICLE ERRORS ──
    // 'a' before vowel sound
    check(/\ba\s+([aeiou]\w*)/gi, m => {
        const word = m[1].toLowerCase();
        const exceptions = ['university','uniform','union','unit','unique','universal','universe',
            'useful','use','used','user','utility','euro','European','one','once','honest','hour','heir','honor'];
        if (exceptions.some(e => word.startsWith(e.toLowerCase()))) return m[0];
        return `an ${m[1]}`;
    }, 'Article Error', 'Use "an" before words starting with a vowel sound');

    // 'an' before consonant sound
    check(/\ban\s+([bcdfghjklmnpqrstvwxyz]\w*)/gi, m => {
        const word = m[1].toLowerCase();
        const silentH = ['hour','honest','honor','heir','herb'];
        if (silentH.some(e => word.startsWith(e))) return m[0];
        const exceptions2 = ['historical','historian'];
        if (exceptions2.some(e => word.startsWith(e))) return m[0];
        return `a ${m[1]}`;
    }, 'Article Error', 'Use "a" before words starting with a consonant sound');

    // ── AUXILIARY VERB ERRORS ──
    const auxRules = [
        [/\bhe\s+didn'?t\s+(\w+s)\b/gi, m => `he didn't ${m[1].replace(/s$/, '')}`, 'Auxiliary Verb Error', 'After "didn\'t", use base verb without -s'],
        [/\bshe\s+didn'?t\s+(\w+s)\b/gi, m => `she didn't ${m[1].replace(/s$/, '')}`, 'Auxiliary Verb Error', 'After "didn\'t", use base verb without -s'],
        [/\bthey\s+doesn'?t\b/gi, () => "they don't", 'Auxiliary Verb Error', '"they doesn\'t" → "they don\'t"'],
        [/\bwe\s+doesn'?t\b/gi, () => "we don't", 'Auxiliary Verb Error', '"we doesn\'t" → "we don\'t"'],
        [/\byou\s+doesn'?t\b/gi, () => "you don't", 'Auxiliary Verb Error', '"you doesn\'t" → "you don\'t"'],
        [/\bi\s+doesn'?t\b/gi, () => "I don't", 'Auxiliary Verb Error', '"I doesn\'t" → "I don\'t"'],
        [/\bcan\s+able\b/gi, () => "can", 'Auxiliary Verb Error', '"can able" is redundant; use only "can" or "am/is/are able"'],
        [/\bcould\s+able\b/gi, () => "could", 'Auxiliary Verb Error', '"could able" is redundant; use only "could"'],
        [/\bwill\s+able\b/gi, () => "will be able", 'Auxiliary Verb Error', '"will able" → "will be able"'],
        [/\bhe\s+can\s+able\b/gi, () => "he can", 'Auxiliary Verb Error', '"can able" is incorrect'],
        [/\bmust\s+to\b/gi, () => "must", 'Auxiliary Verb Error', '"must to" → "must" (no "to" after must)'],
        [/\bshould\s+to\b/gi, () => "should", 'Auxiliary Verb Error', '"should to" → "should" (no "to" after should)'],
        [/\bwould\s+to\b/gi, () => "would", 'Auxiliary Verb Error', '"would to" → "would" (no "to" after would)'],
        [/\bcould\s+to\b/gi, () => "could", 'Auxiliary Verb Error', '"could to" → "could" (no "to" after could)'],
        [/\bmight\s+to\b/gi, () => "might", 'Auxiliary Verb Error', '"might to" → "might" (no "to" after might)'],
    ];
    auxRules.forEach(([re, fix, type, expl]) => check(re, fix, type, expl));

    // ── PREPOSITION ERRORS ──
    const prepRules = [
        [/\bdiscuss\s+about\b/gi, () => "discuss", 'Preposition Error', '"discuss about" → "discuss" (no "about" needed)'],
        [/\bexplain\s+about\b/gi, () => "explain", 'Preposition Error', '"explain about" → "explain" (no "about" needed)'],
        [/\breach\s+to\b(?!\s+the\b)/gi, () => "reach", 'Preposition Error', '"reach to" → "reach" (no "to" after reach)'],
        [/\benter\s+into\b(?!\s+the\b)/gi, () => "enter", 'Preposition Error', '"enter into" → "enter" (no "into" needed)'],
        [/\bmarried\s+with\b/gi, () => "married to", 'Preposition Error', '"married with" → "married to"'],
        [/\bat\s+monday\b/gi, () => "on Monday", 'Preposition Error', '"at Monday" → "on Monday"'],
        [/\bat\s+tuesday\b/gi, () => "on Tuesday", 'Preposition Error', '"at Tuesday" → "on Tuesday"'],
        [/\bat\s+the\s+morning\b/gi, () => "in the morning", 'Preposition Error', '"at the morning" → "in the morning"'],
        [/\bat\s+morning\b/gi, () => "in the morning", 'Preposition Error', '"at morning" → "in the morning"'],
        [/\bat\s+evening\b/gi, () => "in the evening", 'Preposition Error', '"at evening" → "in the evening"'],
        [/\bat\s+night\b/gi, () => "at night", 'Preposition Error', '"at night" is correct — no change needed'],
        [/\bsince\s+(\d+)\s+years\b/gi, m => `for ${m[1]} years`, 'Preposition Error', '"since" is used with a point in time; use "for" with duration'],
        [/\bafraid\s+from\b/gi, () => "afraid of", 'Preposition Error', '"afraid from" → "afraid of"'],
        [/\bproud\s+from\b/gi, () => "proud of", 'Preposition Error', '"proud from" → "proud of"'],
        [/\binterested\s+on\b/gi, () => "interested in", 'Preposition Error', '"interested on" → "interested in"'],
        [/\bdepend\s+on\s+of\b/gi, () => "depend on", 'Preposition Error', '"depend on of" → "depend on"'],
        [/\badvice\s+to\b(?!\s+the\b)/gi, () => "advice on", 'Preposition Error', '"advice to" → "advice on" (or "advise to" if verb)'],
        [/\blisten\s+him\b/gi, () => "listen to him", 'Preposition Error', '"listen him" → "listen to him"'],
        [/\blisten\s+them\b/gi, () => "listen to them", 'Preposition Error', '"listen them" → "listen to them"'],
        [/\blisten\s+her\b/gi, () => "listen to her", 'Preposition Error', '"listen her" → "listen to her"'],
        [/\blisten\s+me\b/gi, () => "listen to me", 'Preposition Error', '"listen me" → "listen to me"'],
    ];
    prepRules.forEach(([re, fix, type, expl]) => {
        if (expl.includes('no change')) return;
        check(re, fix, type, expl);
    });

    // ── COMMON SPELLING / WORD CHOICE ──
    const spellingRules = [
        [/\btheir\s+is\b/gi, () => "there is", 'Spelling/Word Choice', '"their is" → "there is"'],
        [/\btheir\s+are\b/gi, () => "there are", 'Spelling/Word Choice', '"their are" → "there are"'],
        [/\btheir\s+was\b/gi, () => "there was", 'Spelling/Word Choice', '"their was" → "there was"'],
        [/\btheir\s+were\b/gi, () => "there were", 'Spelling/Word Choice', '"their were" → "there were"'],
        [/\bthey're\s+going\s+to\s+there\b/gi, () => "they're going to their", 'Spelling/Word Choice', 'Confused their/there/they\'re'],
        [/\blose\s+(?=weight|game|match|money|time)/gi, null, null, null], // correct
        [/\bloose\s+(?=weight|game|match|money|time)/gi, () => "lose", 'Spelling/Word Choice', '"loose" (adj) vs "lose" (verb) — use "lose"'],
        [/\bcould\s+of\b/gi, () => "could have", 'Spelling/Word Choice', '"could of" → "could have"'],
        [/\bwould\s+of\b/gi, () => "would have", 'Spelling/Word Choice', '"would of" → "would have"'],
        [/\bshould\s+of\b/gi, () => "should have", 'Spelling/Word Choice', '"should of" → "should have"'],
        [/\bmight\s+of\b/gi, () => "might have", 'Spelling/Word Choice', '"might of" → "might have"'],
        [/\bmust\s+of\b/gi, () => "must have", 'Spelling/Word Choice', '"must of" → "must have"'],
        [/\bof\s+course\s+it\s+is\b/gi, null, null, null], // correct
        [/\bvery\s+much\s+important\b/gi, () => "very important", 'Redundancy', '"very much important" → "very important"'],
        [/\bvery\s+much\s+needed\b/gi, () => "very much needed", null, null], // acceptable
        [/\bmore\s+better\b/gi, () => "better", 'Redundancy', '"more better" → "better" (double comparative)'],
        [/\bmore\s+worse\b/gi, () => "worse", 'Redundancy', '"more worse" → "worse" (double comparative)'],
        [/\bmost\s+fastest\b/gi, () => "fastest", 'Redundancy', '"most fastest" → "fastest" (double superlative)'],
        [/\bmost\s+biggest\b/gi, () => "biggest", 'Redundancy', '"most biggest" → "biggest" (double superlative)'],
        [/\bmost\s+smallest\b/gi, () => "smallest", 'Redundancy', '"most smallest" → "smallest" (double superlative)'],
        [/\breturn\s+back\b/gi, () => "return", 'Redundancy', '"return back" → "return" ("back" is redundant)'],
        [/\brevert\s+back\b/gi, () => "revert", 'Redundancy', '"revert back" → "revert" ("back" is redundant)'],
        [/\brepeat\s+again\b/gi, () => "repeat", 'Redundancy', '"repeat again" → "repeat" ("again" is redundant)'],
        [/\badvance\s+forward\b/gi, () => "advance", 'Redundancy', '"advance forward" → "advance" ("forward" is redundant)'],
        [/\bask\s+a\s+question\s+about\b/gi, () => "ask about", 'Redundancy', '"ask a question about" → "ask about" (shorter)'],
        [/\bdue\s+to\s+the\s+fact\s+that\b/gi, () => "because", 'Redundancy', '"due to the fact that" → "because"'],
        [/\bin\s+spite\s+of\s+the\s+fact\s+that\b/gi, () => "although", 'Redundancy', '"in spite of the fact that" → "although"'],
        [/\battention\s+is\s+required\s+to\s+be\s+given\b/gi, () => "attention must be given", 'Sentence Structure', 'Simplify passive construction'],
    ];
    spellingRules.forEach(([re, fix, type, expl]) => {
        if (!fix || !type) return;
        check(re, fix, type, expl);
    });

    // ── CONJUNCTION ERRORS ──
    const conjRules = [
        [/\bAlthough\b[^,]+\b,?\s+but\b/gi, m => m[0].replace(/\bbut\b/i, ''), 'Conjunction Error', '"Although... but" — remove "but"; use only "Although"'],
        [/\bBecause\b[^,]+\b,?\s+therefore\b/gi, m => m[0].replace(/\btherefore\b/i, ''), 'Conjunction Error', '"Because... therefore" — remove "therefore"; use only one'],
        [/\bboth\s+(\w+)\s+as\s+well\s+as\b/gi, m => `both ${m[1]} and`, 'Conjunction Error', '"both...as well as" → "both...and"'],
        [/\beither\s+\w+\s+nor\b/gi, m => m[0].replace(/\bnor\b/, 'or'), 'Conjunction Error', '"either...nor" → "either...or"'],
        [/\bneither\s+\w+\s+or\b/gi, m => m[0].replace(/\bor\b/, 'nor'), 'Conjunction Error', '"neither...or" → "neither...nor"'],
    ];
    conjRules.forEach(([re, fix, type, expl]) => check(re, fix, type, expl));

    // ── PLURAL/SINGULAR NOUN ERRORS ──
    const nounRules = [
        [/\ba\s+informations?\b/gi, () => "information", 'Plural/Singular Noun Error', '"information" is uncountable; use "information" without article'],
        [/\ban?\s+advices?\b/gi, () => "advice", 'Plural/Singular Noun Error', '"advice" is uncountable; use "advice" without article'],
        [/\ban?\s+equipments?\b/gi, () => "equipment", 'Plural/Singular Noun Error', '"equipment" is uncountable'],
        [/\bfurnitures\b/gi, () => "furniture", 'Plural/Singular Noun Error', '"furniture" is uncountable; no plural form'],
        [/\bsoft?wares\b/gi, () => "software", 'Plural/Singular Noun Error', '"software" is uncountable; no plural form'],
        [/\bhardwares\b/gi, () => "hardware", 'Plural/Singular Noun Error', '"hardware" is uncountable; no plural form'],
        [/\bknowledges\b/gi, () => "knowledge", 'Plural/Singular Noun Error', '"knowledge" is uncountable; no plural form'],
        [/\bwater\s+is\s+so\s+hot\b/gi, () => "the water is so hot", 'Article Error', 'Specific water needs "the"'],
        [/\bpeoples\b(?!\s+of\b)/gi, () => "people", 'Plural/Singular Noun Error', '"peoples" → "people" (already plural)'],
        [/\bchilds\b/gi, () => "children", 'Plural/Singular Noun Error', '"childs" → "children"'],
        [/\bmans\b/gi, () => "men", 'Plural/Singular Noun Error', '"mans" → "men"'],
        [/\bwomans\b/gi, () => "women", 'Plural/Singular Noun Error', '"womans" → "women"'],
        [/\bfoots\b(?!\s+note)/gi, () => "feet", 'Plural/Singular Noun Error', '"foots" → "feet"'],
        [/\btooths\b/gi, () => "teeth", 'Plural/Singular Noun Error', '"tooths" → "teeth"'],
        [/\bgooses\b/gi, () => "geese", 'Plural/Singular Noun Error', '"gooses" → "geese"'],
        [/\bmouses\b(?!\s+pad)/gi, () => "mice", 'Plural/Singular Noun Error', '"mouses" → "mice"'],
    ];
    nounRules.forEach(([re, fix, type, expl]) => check(re, fix, type, expl));

    // ── CALCULATE SCORE ──
    const n = errors.length;
    let score;
    if (n === 0) score = 100;
    else if (n === 1) score = 90;
    else if (n <= 4) score = Math.max(75, 88 - (n - 2) * 5);
    else if (n <= 7) score = Math.max(60, 74 - (n - 5) * 5);
    else if (n <= 12) score = Math.max(40, 59 - (n - 8) * 4);
    else score = Math.max(0, 39 - (n - 13) * 3);

    let feedback;
    if (score >= 90) feedback = "Excellent! Your English is very fluent with minimal errors.";
    else if (score >= 75) feedback = "Good! A few grammar errors but overall clear and understandable.";
    else if (score >= 60) feedback = "Average. Work on the highlighted grammar patterns to improve.";
    else if (score >= 40) feedback = "Below average. Focus on subject-verb agreement and sentence structure.";
    else feedback = "Needs significant improvement. Practice basic grammar rules daily.";

    return { errors, score, feedback };
}

app.post("/speaking/analyze", (req, res) => {
    const { transcript, topic } = req.body;
    if (!transcript || !transcript.trim()) return res.status(400).json({ error: "No transcript provided" });
    const wordCount = transcript.trim().split(/\s+/).length;
    const result = analyzeGrammar(transcript);
    res.json({ ...result, wordCount, topic: topic || "" });
});

app.use(express.static(__dirname));
app.get("/", (req, res) => { const p = path.join(__dirname, "index.html"); fs.existsSync(p) ? res.sendFile(p) : res.status(500).send("index.html not found"); });
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use((req, res) => res.status(404).json({ error: "Not found", path: req.path }));
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

const PORT = process.env.PORT || 5000;
boot().then(() => {
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log("TEJAPRATAP QUIZ SERVER v5.0 on port " + PORT);
        console.log("App: http://localhost:" + PORT);
    });
    process.on("SIGTERM", async () => { await saveData(); server.close(() => console.log("Closed")); });
    process.on("SIGINT",  async () => { await saveData(); process.exit(0); });
}).catch(e => { console.error("Boot failed:", e); process.exit(1); });

module.exports = app;
