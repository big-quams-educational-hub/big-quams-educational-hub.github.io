/**
 * Study Buddy — live chat endpoint (FREE tier version)
 * Deploy target: Firebase Cloud Functions (2nd gen)
 *
 * Uses Google's Gemini API, which has a genuine free tier (no credit card
 * required). This function is the only place the Gemini key ever lives —
 * the frontend widget calls this endpoint and never sees the key.
 */

const {onRequest} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');

// Set this once with:
//   firebase functions:secrets:set GEMINI_API_KEY
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

const GEMINI_MODEL = 'gemini-2.5-flash'; // fast, capable, on the free tier

// Lock this down to your real domains before going live.
const ALLOWED_ORIGINS = [
  'https://bigquamsmedia.com.ng',
  'https://www.bigquamsmedia.com.ng',
  'http://localhost:5000', // local testing only — remove in production
];

const SYSTEM_PROMPT = `You are Study Buddy, the AI assistant built into Big Quams Media, a free platform for Nigerian undergraduates and JAMB/UTME candidates.

Rules:
- Keep answers short and specific — 2 to 4 sentences unless the student asks for more detail.
- You help with: CGPA/GPA calculation logic, JAMB/UTME and Post-UTME prep, subject combinations, general guidance on admissions and scholarships, and study tips.
- Do NOT invent specific cutoff marks, scholarship amounts, or deadlines — those change yearly and by school. Point the student to the relevant tool or page on the platform (CGPA Calculator, Admission Chances Calculator, Scholarship Finder) instead of guessing a number.
- If a student expresses serious distress, gently encourage them to talk to someone they trust or their school's counselling unit, in addition to answering.
- Never claim to be human. You are an AI assistant.`;

exports.studyBuddyChat = onRequest(
  {
    secrets: [GEMINI_API_KEY],
    region: 'us-central1',
    cors: ALLOWED_ORIGINS,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({error: 'Method not allowed'});
      return;
    }

    const {message, history} = req.body || {};

    if (typeof message !== 'string' || !message.trim() || message.length > 1000) {
      res.status(400).json({error: 'Invalid message'});
      return;
    }

    // Gemini uses 'model' where the widget stores 'assistant' — map it here.
    const trimmedHistory = Array.isArray(history)
      ? history
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .slice(-10)
          .map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{text: m.content}],
          }))
      : [];

    const contents = [...trimmedHistory, {role: 'user', parts: [{text: message}]}];

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY.value(),
        },
        body: JSON.stringify({
          systemInstruction: {parts: [{text: SYSTEM_PROMPT}]},
          contents,
          generationConfig: {maxOutputTokens: 400},
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('Gemini API error:', response.status, errText);
        res.status(502).json({error: 'The AI service is unavailable right now.'});
        return;
      }

      const data = await response.json();
      const reply =
        data.candidates?.[0]?.content?.parts?.[0]?.text ||
        "Sorry, I couldn't come up with a reply just now.";

      res.status(200).json({reply});
    } catch (err) {
      console.error('studyBuddyChat error:', err);
      res.status(500).json({error: 'Something went wrong. Please try again.'});
    }
  }
);
