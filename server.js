/**
 * Audit generation: Google Places + Claude.
 * Env: GOOGLE_PLACES_API_KEY, ANTHROPIC_API_KEY
 * Optional: ANTHROPIC_MODEL (default claude-sonnet-4-5-20250929), PORT (default 3000)
 */
require('dotenv').config();

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

/** Maps form businessType → Google Places `type` for nearbysearch */
const BUSINESS_TYPE_TO_GOOGLE_TYPE = {
  dental: 'dentist',
  gym: 'gym',
  cafe: 'cafe',
  restaurant: 'restaurant',
  salon: 'beauty_salon',
  hotel: 'lodging',
  school: 'school',
  healthcare: 'doctor',
  other: 'establishment',
};

const CLAUDE_MODEL =
  process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';

const SYSTEM_PROMPT = `You are a senior digital marketing auditor for Indian SMBs in Bangalore.
You will receive real business data and must return ONLY a valid JSON object, no extra text, no markdown, no explanation.

Calculate scores based on these rules:
- Google score (0-10): 10 if 200+ reviews and 4.5+ rating, scale down proportionally
- Instagram score (0-10): 10 if 10000+ followers, scale down proportionally
- WhatsApp score (0-10): 10 if has WhatsApp Business, 2 if not
- Website score (0-10): 10 if has website, 0 if not
- Ads score (0-10): 10 if running ads, 0 if not
- Overall score: weighted average (Google 35%, Instagram 25%, WhatsApp 15%, Website 15%, Ads 10%)

Revenue loss calculation:
- Use average customer values for Bangalore: dental ₹2500, gym ₹1500, cafe ₹800, restaurant ₹1200, salon ₹1000, hotel ₹4000, school ₹8000, healthcare ₹2000, other ₹1500
- Monthly loss low = reviewGap × 0.05 × avgCustomerValue
- Monthly loss high = reviewGap × 0.15 × avgCustomerValue
- If no review gap, base loss on missing platforms × ₹10000

Return exactly this JSON structure:
{
  "score": number,
  "googleScore": number,
  "instagramScore": number,
  "whatsappScore": number,
  "websiteScore": number,
  "adsScore": number,
  "googleReviews": number,
  "googleRating": number,
  "competitorAvgReviews": number,
  "reviewGap": number,
  "listedOnGoogle": boolean,
  "monthlyLossLow": number,
  "monthlyLossHigh": number,
  "annualLoss": number,
  "competitors": [{"name": string, "reviews": number, "rating": number}],
  "topGaps": [string, string, string],
  "freeActions": [string, string, string],
  "roadmap": {
    "month1": string,
    "month2": string,
    "month3": string
  },
  "recommendedPackage": string,
  "summary": string
}`;

function normalizeGoogleType(businessType) {
  const key = String(businessType || 'other')
    .toLowerCase()
    .trim();
  return BUSINESS_TYPE_TO_GOOGLE_TYPE[key] ?? BUSINESS_TYPE_TO_GOOGLE_TYPE.other;
}

async function placesJson(url) {
  const res = await fetch(url);
  const data = await res.json();
  return data;
}

/**
 * @returns {Promise<{
 *   googleReviews: number|null,
 *   googleRating: number|null,
 *   listedOnGoogle: boolean,
 *   placeId: string|null,
 *   name: string|null,
 *   lat: number|null,
 *   lng: number|null,
 *   competitors: {name: string, reviews: number, rating: number|null}[],
 *   competitorAvgReviews: number|null
 * }>}
 */
async function fetchGoogleData(businessName, city, businessType) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  const empty = {
    googleReviews: null,
    googleRating: null,
    listedOnGoogle: false,
    placeId: null,
    name: null,
    lat: null,
    lng: null,
    competitors: [],
    competitorAvgReviews: null,
  };

  if (!key) {
    console.warn('fetchGoogleData: GOOGLE_PLACES_API_KEY is not set');
    return empty;
  }

  const query = [businessName, city].filter(Boolean).join(' ').trim();
  if (!query) {
    return empty;
  }

  try {
    const fields = [
      'place_id',
      'name',
      'rating',
      'user_ratings_total',
      'geometry',
      'business_status',
    ].join(',');

    const findUrl =
      `${PLACES_BASE}/findplacefromtext/json?` +
      new URLSearchParams({
        input: query,
        inputtype: 'textquery',
        fields,
        key,
      });

    const findData = await placesJson(findUrl);
    if (findData.status !== 'OK' || !findData.candidates?.length) {
      return empty;
    }

    let candidate = findData.candidates[0];
    let placeId = candidate.place_id || null;
    let googleRating =
      typeof candidate.rating === 'number' ? candidate.rating : null;
    let googleReviews =
      typeof candidate.user_ratings_total === 'number'
        ? candidate.user_ratings_total
        : null;
    const lat = candidate.geometry?.location?.lat ?? null;
    const lng = candidate.geometry?.location?.lng ?? null;
    let placeName = candidate.name || null;

    if (
      placeId &&
      (googleRating == null || googleReviews == null)
    ) {
      const detailFields = 'name,rating,user_ratings_total,geometry';
      const detailUrl =
        `${PLACES_BASE}/details/json?` +
        new URLSearchParams({
          place_id: placeId,
          fields: detailFields,
          key,
        });
      const detailData = await placesJson(detailUrl);
      if (detailData.status === 'OK' && detailData.result) {
        const r = detailData.result;
        placeName = r.name || placeName;
        if (typeof r.rating === 'number') googleRating = r.rating;
        if (typeof r.user_ratings_total === 'number')
          googleReviews = r.user_ratings_total;
      }
    }

    const listedOnGoogle = Boolean(placeId);

    if (lat == null || lng == null) {
      return {
        googleReviews,
        googleRating,
        listedOnGoogle,
        placeId,
        name: placeName,
        lat,
        lng,
        competitors: [],
        competitorAvgReviews: null,
      };
    }

    const googleType = normalizeGoogleType(businessType);
    const nearbyUrl =
      `${PLACES_BASE}/nearbysearch/json?` +
      new URLSearchParams({
        location: `${lat},${lng}`,
        radius: '5000',
        type: googleType,
        key,
      });

    const nearbyData = await placesJson(nearbyUrl);
    let results = nearbyData.results || [];

    results = results.filter((r) => r.place_id && r.place_id !== placeId);

    results.sort((a, b) => {
      const ta = a.user_ratings_total ?? 0;
      const tb = b.user_ratings_total ?? 0;
      return tb - ta;
    });

    const top = results.slice(0, 3).map((r) => ({
      name: r.name || 'Unknown',
      reviews: typeof r.user_ratings_total === 'number' ? r.user_ratings_total : 0,
      rating: typeof r.rating === 'number' ? r.rating : null,
    }));

    let competitorAvgReviews = null;
    if (top.length) {
      const sum = top.reduce((s, c) => s + (c.reviews || 0), 0);
      competitorAvgReviews = Math.round(sum / top.length);
    }

    return {
      googleReviews,
      googleRating,
      listedOnGoogle,
      placeId,
      name: placeName,
      lat,
      lng,
      competitors: top,
      competitorAvgReviews,
    };
  } catch (err) {
    console.error('fetchGoogleData error:', err.message);
    return empty;
  }
}

function padCompetitors(competitors) {
  const out = [...competitors];
  while (out.length < 3) {
    out.push({ name: '—', reviews: 0, rating: null });
  }
  return out.slice(0, 3);
}

function buildUserMessage(formData, googleData) {
  const igFollowers = Number(formData.igFollowers) || 0;
  const hasWhatsapp = Boolean(formData.hasWhatsapp);
  const hasWebsite = Boolean(formData.hasWebsite);
  const runningAds = Boolean(formData.runningAds);

  const gReviews = googleData.googleReviews ?? 0;
  const gRating = googleData.googleRating ?? '—';
  const listed = googleData.listedOnGoogle;
  const compAvg = googleData.competitorAvgReviews ?? '—';

  const [c1, c2, c3] = padCompetitors(googleData.competitors || []);

  const fmt = (c) => {
    const r = c.rating != null ? `${c.rating}` : '—';
    return `${c.name} - ${c.reviews} reviews, ${r} stars`;
  };

  return `Business: ${formData.businessName}, ${formData.city}
Type: ${formData.businessType}
Google Reviews: ${gReviews}
Google Rating: ${gRating}
Listed on Google: ${listed}
Instagram Followers: ${igFollowers}
Has WhatsApp Business: ${hasWhatsapp}
Has Website: ${hasWebsite}
Running Ads: ${runningAds}
Competitor 1: ${fmt(c1)}
Competitor 2: ${fmt(c2)}
Competitor 3: ${fmt(c3)}
Competitor average reviews: ${compAvg}`;
}

function extractJsonFromText(text) {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1].trim() : trimmed;
  return JSON.parse(raw);
}

async function generateAudit(formData, googleData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const client = new Anthropic({ apiKey });
  const userMessage = buildUserMessage(formData, googleData);

  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return extractJsonFromText(text);
}

function normalizeBody(body) {
  return {
    businessName: body.businessName ?? body.bizName ?? '',
    businessType: body.businessType ?? body.bizType ?? 'other',
    city: body.city ?? '',
    area: body.area ?? '',
    igFollowers: body.igFollowers ?? 0,
    hasWhatsapp:
      body.hasWhatsapp === true ||
      body.hasWhatsapp === 'yes' ||
      body.hasWhatsapp === 'true',
    hasWebsite:
      body.hasWebsite === true ||
      body.hasWebsite === 'yes' ||
      body.hasWebsite === 'true',
    websiteUrl: body.websiteUrl ?? body.website ?? '',
    runningAds:
      body.runningAds === true ||
      body.runningAds === 'yes' ||
      body.runningAds === 'true',
    userName: body.userName ?? body.leadName ?? '',
    userWhatsapp: body.userWhatsapp ?? body.leadPhone ?? '',
  };
}

const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.post('/api/generate-audit', async (req, res) => {
  try {
    const formData = normalizeBody(req.body || {});

    if (!formData.businessName || !formData.city) {
      return res.status(400).json({
        ok: false,
        error: 'businessName and city are required',
      });
    }

    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'Server misconfiguration: GOOGLE_PLACES_API_KEY is missing',
      });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'Server misconfiguration: ANTHROPIC_API_KEY is missing',
      });
    }

    const googleData = await fetchGoogleData(
      formData.businessName,
      [formData.city, formData.area].filter(Boolean).join(' '),
      formData.businessType
    );

    const audit = await generateAudit(formData, googleData);

    return res.json({
      ok: true,
      googleData,
      audit,
    });
  } catch (err) {
    console.error('/api/generate-audit', err);
    return res.status(500).json({
      ok: false,
      error:
        err.message ||
        'Audit generation failed. Check API keys and model availability.',
    });
  }
});

app.post('/api/send-whatsapp', async (req, res) => {
  try {
    const { to, message, pdfBase64, pdfName } = req.body;

    if (!to || !pdfBase64) {
      return res.status(400).json({ ok: false, error: 'Recipient phone and PDF data are required' });
    }

    // CUSTOM WHATSAPP GATEWAY (Example: Ultramsg, Vbiz, etc.)
    // Your provided admin number: 9632091371
    const fromPhone = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+919632091371';

    console.log(`Sending WhatsApp report from ${fromPhone} to user: ${to}...`);

    // NOTIFY ADMIN OPTION (Owner notification)
    if (req.body.notifyAdmin) {
      const adminPhone = process.env.ADMIN_WHATSAPP_NUMBER || '9632091371';
      console.log(`Notifying Owner at ${adminPhone} about new audit for ${req.body.bizName || 'Unknown Business'}...`);
    }

    // Example: If using a real API provider, you would place the fetch here:
    /*
    const apiRes = await fetch('YOUR_API_GATEWAY_URL', {
       method: 'POST',
       body: JSON.stringify({
          to: to,
          from: fromPhone,
          message: message,
          pdf: pdfBase64
       })
    });
    */
    /*
    const client = require('twilio')(accountSid, authToken);
    await client.messages.create({
      from: fromPhone,
      to: `whatsapp:${to.startsWith('+') ? to : '+91' + to}`,
      body: message,
      // mediaUrl: [publicPdfUrl] // Twilio requires a URL
    });
    */

    return res.json({ ok: true, message: 'WhatsApp sent successfully' });
  } catch (err) {
    console.error('/api/send-whatsapp error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/send-email', async (req, res) => {
  try {
    console.log("---- /api/send-email RECEIVED ----");
    const { to, bizName, pdfBase64, pdfName } = req.body;
    console.log(`Recipient: ${to}`);
    console.log(`Business Name: ${bizName}`);

    if (!to) {
      console.log("ERROR: Missing 'to' email address.");
      return res.status(400).json({ ok: false, error: 'Recipient email is required' });
    }

    if (!pdfBase64 || pdfBase64.trim() === '') {
      console.log("ERROR: Missing PDF data content.");
      return res.status(400).json({ ok: false, error: 'PDF content is required' });
    }

    const finalPdfBase64 = pdfBase64;

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER || 'rohanbiradar2342001@gmail.com',
        pass: process.env.EMAIL_PASS || 'wxml eygy jtvv vxhq',
      }
    });

    const mailOptions = {
      from: `"Numero Uno Marketing" <${process.env.EMAIL_USER || 'rohanbiradar2342001@gmail.com'}>`,
      to: to,
      subject: `Your AI Digital Audit Report: ${bizName || 'Your Business'}`,
      text: `Hi,

Thank you for choosing Numero Uno Marketing! Your comprehensive AI Digital Audit report for ${bizName || 'your business'} is attached.

Our team will review these findings and reach out to you within 24 hours to discuss your personalised growth strategy.

Best regards,
Numero Uno Marketing Team`,
      attachments: [
        {
          filename: pdfName || 'AI_Audit_Report.pdf',
          content: finalPdfBase64,
          encoding: 'base64'
        }
      ]
    };

    if (!process.env.EMAIL_PASS) {
      console.warn('EMAIL_PASS not configured. Mocking email success.');
      return res.json({ ok: true, message: 'Mock email sent (Credentials missing)' });
    }

    console.log(`Sending Nodemailer to ${to} ...`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`Email report sent to ${to} for ${bizName}. Message ID: ${info.messageId}`);

    return res.json({ ok: true, message: 'Email sent successfully', id: info.messageId });
  } catch (err) {
    console.error('/api/send-email FATAL ERROR:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Audit API listening on http://localhost:${PORT}`);
});

module.exports = {
  app,
  fetchGoogleData,
  generateAudit,
  normalizeGoogleType,
};
