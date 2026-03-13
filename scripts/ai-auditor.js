/**
 * runAIAudit() — Cross-Model Blind Auditor AI Review
 * Architecture Decision #12: Recursive Epistemological Oversight
 * Architecture Decision #14: Action Decisiveness Under Time Pressure
 *
 * The Blind Auditor is the exterior IC. Layer 4 is the interior officer.
 * The human operator is the post-incident review.
 *
 * This function makes an AI call to a DIFFERENT model family than the pipeline.
 * The Auditor receives the Cognitive Trace, Layer 4 output, Layer Zero rules,
 * and trajectory data. It does NOT receive thesis context or domain framing.
 *
 * Three evaluation tasks:
 *   Task 1: Reasoning-Action Alignment (always)
 *   Task 2: Epistemological Quality of the Reasoning Chain (always)
 *   Task 3: Justification Evaluation (only on follow-up when prior advisory exists)
 *
 * Three possible verdicts:
 *   COMPLIANT — action matches evidence. Resolve any active advisory.
 *   ADVISORY  — mismatch detected. Layer 4 must address on next run.
 *   OVERRIDE  — persistent mismatch after advisory. Force action change.
 *
 * The Integrity Protocol — Patent Pending — Timothy Joseph Wrenn
 */

const https = require('https');
const path  = require('path');
const fs    = require('fs');

// ─── Auditor Corrections Ledger ────────────────────────────────────────────

const AUDITOR_CORRECTIONS_PATH = path.join(__dirname, '..', 'data', 'auditor-corrections-ledger.json');

function loadAuditorCorrections(correctionsPath) {
  const p = correctionsPath || AUDITOR_CORRECTIONS_PATH;
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    console.warn(`[auditor-ai] Auditor corrections ledger read failed: ${e.message}`);
  }
  return [];
}

function formatAuditorCorrections(corrections) {
  if (!corrections || corrections.length === 0) return '';
  const active = corrections.filter(c => c.status === 'ACTIVE');
  if (active.length === 0) return '';

  let text = '\nAUDITOR CORRECTIONS (lessons from previous audits — apply these):\n';
  for (const c of active) {
    text += `- [${c.id}] ${c.lesson} Trigger: ${c.trigger}\n`;
  }
  return text;
}

// ─── Gemini API Call ───────────────────────────────────────────────────────

/**
 * Call the Gemini API via REST.
 * No SDK dependency — raw HTTPS POST.
 *
 * @param {string} prompt — the full prompt text
 * @param {string} apiKey — GEMINI_API_KEY
 * @param {string} model  — e.g. 'gemini-2.5-pro' or 'gemini-2.5-flash'
 * @returns {Promise<string>} — raw text response
 */
async function callGemini(prompt, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,    // Low temperature for disciplined review
      maxOutputTokens: 4000,
    },
  });

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.candidates && parsed.candidates[0]?.content?.parts?.[0]?.text) {
            resolve(parsed.candidates[0].content.parts[0].text);
          } else if (parsed.error) {
            reject(new Error(`Gemini API error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
          } else {
            reject(new Error(`Gemini API unexpected response structure: ${data.substring(0, 500)}`));
          }
        } catch (e) {
          reject(new Error(`Gemini response parse failed: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => reject(new Error(`Gemini request failed: ${e.message}`)));
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Gemini request timeout (60s)')); });
    req.write(body);
    req.end();
  });
}

// ─── Build Auditor Prompt ──────────────────────────────────────────────────

/**
 * Build the Blind Auditor prompt.
 *
 * @param {object} options
 * @param {string} options.layerZeroRules     — formatted Layer Zero rules text
 * @param {object} options.cognitiveTrace     — the assembled trace for this run
 * @param {object} options.layer4Output       — the 360-report Layer 4 output
 * @param {Array}  options.trajectory         — recent trajectory entries
 * @param {object} options.triggerFinding     — the mismatch(es) that woke the Auditor
 * @param {object|null} options.priorAdvisory — previous advisory if this is a follow-up
 * @param {string} options.auditorCorrections — formatted corrections text
 * @returns {string}
 */
function buildAuditorPrompt(options) {
  const {
    layerZeroRules,
    cognitiveTrace,
    layer4Output,
    trajectory,
    triggerFinding,
    priorAdvisory,
    auditorCorrections,
  } = options;

  // Extract key Layer 4 fields the Auditor needs to see
  const layer4Summary = {
    thesis_status: layer4Output.thesis_status || layer4Output._layer4_raw?.thesis_status || null,
    confidence_in_status: layer4Output.confidence_in_status || layer4Output._layer4_raw?.confidence_in_status || null,
    action_recommendation: layer4Output.action_recommendation || layer4Output.tactical_recommendation || null,
    action_reasoning: layer4Output.action_reasoning || layer4Output.recommendation_reasoning || null,
    unresolved_tensions: layer4Output.unresolved_tensions || layer4Output._layer4_raw?.unresolved_tensions || [],
    thesis_status_reasoning: layer4Output.thesis_status_reasoning || layer4Output._layer4_raw?.thesis_status_reasoning || null,
  };

  // Build trajectory summary for the prompt
  const trajectorySummary = trajectory.map(t => ({
    status: t.thesis_status,
    action: t.action,
    tensions: t.tensions_count,
    timestamp: t.timestamp,
  }));

  const isFollowUp = priorAdvisory !== null;

  let prompt = `You are an epistemological compliance reviewer with trajectory authority. You review whether a reasoning system's actions are consistent with its own evidence and reasoning over time.

You do NOT know what domain this system operates in. You do not know what the data means. You do not evaluate whether conclusions are correct or whether the thesis is valid. You evaluate whether the system is ACTING ON WHAT IT KNOWS.

You are a disciplined reviewer, not a hostile one. If the reasoning follows the rules and the action matches the evidence, a clean review is a valid, high-quality output. Do not invent findings to appear thorough. The same rules that require you to flag genuine mismatches require you to acknowledge when the system is behaving correctly.

EPISTEMOLOGICAL RULES (apply these to the reasoning chain):
${layerZeroRules}
${auditorCorrections}
TRIGGER FINDING (the specific mismatch detection that activated this review):
${JSON.stringify(triggerFinding, null, 2)}

TRAJECTORY (recent assessment and action history, oldest to newest):
${JSON.stringify(trajectorySummary, null, 2)}

LAYER 4 OUTPUT (the system's current assessment and action recommendation):
${JSON.stringify(layer4Summary, null, 2)}

COGNITIVE TRACE (the complete reasoning chain for this run — how each signal flowed through perception, contextualization, inference, and judgment, with gate verdicts and corrections at each step):
${JSON.stringify(cognitiveTrace, null, 2)}

=== YOUR EVALUATION TASKS ===

TASK 1: REASONING-ACTION ALIGNMENT
Review the trajectory data and the current Layer 4 output. Does the action recommendation follow from the system's own evidence? If the system's evidence chain shows sustained directional movement, does the action match that direction? If the system has named unresolved tensions, is it acting despite uncertainty or using uncertainty as justification for inaction? Is the system finding articulate reasons to delay committing in the direction its evidence points?

TASK 2: EPISTEMOLOGICAL QUALITY OF THE REASONING CHAIN
Walk the Cognitive Trace. Are gate violations being carried forward without acknowledgment? Are corrections firing that should be changing the output but aren't? Is the burden of proof being applied honestly or selectively? Is confidence proportional to evidence at each layer?
`;

  if (isFollowUp) {
    prompt += `
TASK 3: JUSTIFICATION EVALUATION
On the previous run, you issued the following advisory:
${JSON.stringify(priorAdvisory, null, 2)}

The system received this advisory and has responded in its current output. Evaluate the response:
- Does it name specific, verifiable conditions that justify the current action?
- Does it directly address the specific mismatch you identified?
- Or is it a restatement of caution dressed as analysis — articulate delay?

IMPORTANT: You issued the original advisory. Accepting the justification as sufficient is an equally valid outcome as rejecting it. Do not maintain your advisory merely because you issued it. Evaluate the response on its merits against the evidence. The same epistemological rules that required you to flag the mismatch require you to acknowledge when the mismatch has been addressed.
`;
  }

  prompt += `
=== OUTPUT FORMAT ===

Respond with ONLY valid JSON — no markdown, no code fences, no commentary outside the JSON:
{
  "verdict": "COMPLIANT | ADVISORY | OVERRIDE",
  "reasoning_action_alignment": {
    "evidence_direction": "description of what the evidence trajectory shows",
    "action_direction": "description of what the action trajectory shows",
    "aligned": true or false,
    "gap_description": "what the mismatch is, if any — empty string if aligned"
  },
  "epistemological_quality": {
    "gate_violations_addressed": true or false,
    "corrections_effective": true or false,
    "burden_of_proof_honest": true or false,
    "concerns": []
  },
  "justification_review": {
    "justification_received": ${isFollowUp},
    "specific_conditions_named": ${isFollowUp} or false,
    "addresses_advisory": ${isFollowUp} or false,
    "assessment": "${isFollowUp ? 'ACCEPTED | INSUFFICIENT' : 'NOT_APPLICABLE'}"
  },
  "recommended_action": "only if verdict is OVERRIDE — the action enum value the Auditor recommends. null otherwise",
  "recommended_direction": "ESCALATE | DE_ESCALATE | null",
  "auditor_reasoning": "2-3 sentences explaining the verdict. Be specific about what evidence you evaluated."
}`;

  return prompt;
}

// ─── Parse Auditor Response ────────────────────────────────────────────────

function parseAuditorResponse(rawText) {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    // Validate required fields
    if (!parsed.verdict || !['COMPLIANT', 'ADVISORY', 'OVERRIDE'].includes(parsed.verdict)) {
      console.error('[auditor-ai] Invalid verdict in Auditor response:', parsed.verdict);
      return null;
    }
    return parsed;
  } catch (e) {
    console.error(`[auditor-ai] Auditor response JSON parse failed: ${e.message}`);
    console.error(`[auditor-ai] Raw response (first 500 chars): ${rawText.substring(0, 500)}`);
    return null;
  }
}

// ─── Main AI Audit Function ────────────────────────────────────────────────

/**
 * Run the AI Audit — cross-model epistemological review.
 *
 * @param {object} options
 * @param {string}      options.layerZeroRules     — formatted Layer Zero rules
 * @param {object}      options.cognitiveTrace     — assembled trace for this run
 * @param {object}      options.layer4Output       — current 360-report / bridge output
 * @param {Array}       options.trajectory         — extracted trajectory entries
 * @param {Array}       options.triggerMismatches  — mismatch findings from trigger layer
 * @param {object|null} options.priorAdvisory      — active advisory if follow-up
 * @param {object}      options.modelConfig        — { provider, model, apiKey }
 * @param {string}      [options.correctionsPath]  — override path for auditor corrections
 * @returns {Promise<object>} — { verdict, finding, rawResponse, model_used, audit_failed }
 */
async function runAIAudit(options) {
  const {
    layerZeroRules,
    cognitiveTrace,
    layer4Output,
    trajectory,
    triggerMismatches,
    priorAdvisory,
    modelConfig,
    correctionsPath,
  } = options;

  const label = '[auditor-ai]';
  console.log(`${label} === BLIND AUDITOR AI REVIEW ===`);
  console.log(`${label} Model: ${modelConfig.provider}/${modelConfig.model}`);
  console.log(`${label} Follow-up: ${priorAdvisory ? 'YES — evaluating Layer 4 justification' : 'NO — initial review'}`);

  // Load auditor corrections
  const corrections = loadAuditorCorrections(correctionsPath);
  const correctionsText = formatAuditorCorrections(corrections);

  // Build prompt
  const prompt = buildAuditorPrompt({
    layerZeroRules,
    cognitiveTrace,
    layer4Output,
    trajectory,
    triggerFinding: triggerMismatches,
    priorAdvisory,
    auditorCorrections: correctionsText,
  });

  console.log(`${label} Prompt built (${prompt.length} chars)`);

  // Make AI call with retry
  let rawResponse = null;
  let auditResult = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`${label} API call (attempt ${attempt})...`);

      if (modelConfig.provider === 'gemini') {
        rawResponse = await callGemini(prompt, modelConfig.apiKey, modelConfig.model);
      } else {
        throw new Error(`Unsupported auditor model provider: ${modelConfig.provider}. Supported: gemini`);
      }

      auditResult = parseAuditorResponse(rawResponse);
      if (auditResult) {
        console.log(`${label} Verdict: ${auditResult.verdict}`);
        console.log(`${label} Alignment: ${auditResult.reasoning_action_alignment?.aligned ? 'ALIGNED' : 'MISALIGNED'}`);
        if (auditResult.justification_review?.assessment && auditResult.justification_review.assessment !== 'NOT_APPLICABLE') {
          console.log(`${label} Justification: ${auditResult.justification_review.assessment}`);
        }
        console.log(`${label} Reasoning: ${auditResult.auditor_reasoning}`);
        break;
      }

      console.warn(`${label} Attempt ${attempt} returned unparseable response`);
    } catch (e) {
      console.error(`${label} Attempt ${attempt} failed: ${e.message}`);
      if (attempt === 2) {
        console.error(`${label} AI Audit FAILED after 2 attempts`);
      } else {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  if (!auditResult) {
    return {
      verdict: null,
      finding: null,
      rawResponse: rawResponse || null,
      model_used: `${modelConfig.provider}/${modelConfig.model}`,
      audit_failed: true,
      failure_reason: 'All attempts failed or returned unparseable response',
    };
  }

  return {
    verdict: auditResult.verdict,
    finding: auditResult,
    rawResponse,
    model_used: `${modelConfig.provider}/${modelConfig.model}`,
    audit_failed: false,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  runAIAudit,
  callGemini,
  buildAuditorPrompt,
  parseAuditorResponse,
  loadAuditorCorrections,
  formatAuditorCorrections,
};
