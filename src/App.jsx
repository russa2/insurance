import React, { useState, useRef, useMemo } from "react";
import {
  FileText,
  Upload,
  Trash2,
  ShieldCheck,
  ShieldAlert,
  Loader2,
  Sparkles,
  ClipboardPaste,
  RotateCcw,
  Search,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Info,
  Printer,
} from "lucide-react";
import * as mammoth from "mammoth";

/* -------------------------------------------------------------------------- */
/*  Insurance Claim Checker — public deploy version                            */
/*  Client calls /api/analyze (a Vercel serverless function) so the Anthropic  */
/*  API key never ships to the browser. If the serverless call fails, the app  */
/*  falls back to an offline keyword/exclusion scanner.                        */
/* -------------------------------------------------------------------------- */

// Dynamically load a script from CDN if it isn't present yet.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}

async function ensurePdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await loadScript(
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"
  );
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  return window.pdfjsLib;
}

async function ensureTesseract() {
  if (window.Tesseract) return window.Tesseract;
  await loadScript(
    "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js"
  );
  return window.Tesseract;
}

// ------------- file extraction --------------------------------------------
async function extractText(file, onProgress) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt") || file.type === "text/plain") {
    return await file.text();
  }
  if (name.endsWith(".docx")) {
    const buf = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buf });
    return result.value || "";
  }
  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const pdfjsLib = await ensurePdfJs();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let out = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const txt = await page.getTextContent();
      out += txt.items.map((it) => it.str).join(" ") + "\n\n";
      onProgress && onProgress(i / pdf.numPages);
    }
    return out;
  }
  if (file.type.startsWith("image/")) {
    const Tesseract = await ensureTesseract();
    const { data } = await Tesseract.recognize(file, "eng", {
      logger: (m) => onProgress && m.progress && onProgress(m.progress),
    });
    return data.text || "";
  }
  return await file.text();
}

// ------------- keyword analysis engine -------------------------------------
const EXCLUSION_PHRASES = [
  "not covered",
  "is not a covered",
  "are not covered",
  "excluded",
  "exclusion",
  "we do not cover",
  "no coverage",
  "non-covered",
  "not eligible",
  "ineligible",
  "denied",
  "shall not pay",
  "will not pay",
  "limitation",
  "limited to",
  "only when",
];
const COVERAGE_PHRASES = [
  "covered",
  "we cover",
  "is a covered",
  "are covered",
  "benefits include",
  "we will pay",
  "shall pay",
  "eligible for benefits",
  "preventive",
  "in-network",
  "subject to deductible",
  "copay",
  "coinsurance",
];
const STOPWORDS = new Set(
  "a an and are as at be by for from has have he her him his i if in into is it its of on or our she that the their them they this to was we were what when where which who why will with you your".split(
    " "
  )
);

function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && w.length > 2 && !STOPWORDS.has(w));
}

function topTerms(text, n = 12) {
  const counts = {};
  for (const w of tokenize(text)) counts[w] = (counts[w] || 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

function findSnippets(corpus, terms, max = 6) {
  const sentences = corpus.split(/(?<=[\.\!\?])\s+(?=[A-Z0-9])/);
  const snippets = [];
  let runningPos = 0;
  for (const sent of sentences) {
    const sLower = sent.toLowerCase();
    const matched = terms.find((t) => sLower.includes(t));
    if (matched) {
      snippets.push({ sentence: sent.trim(), matched, position: runningPos });
      if (snippets.length >= max) break;
    }
    runningPos += sent.length + 1;
  }
  return snippets;
}

function classifySnippet(s) {
  const sLower = s.sentence.toLowerCase();
  const exclusion = EXCLUSION_PHRASES.find((p) => sLower.includes(p));
  if (exclusion) return { kind: "exclusion", phrase: exclusion };
  const coverage = COVERAGE_PHRASES.find((p) => sLower.includes(p));
  if (coverage) return { kind: "coverage", phrase: coverage };
  return { kind: "neutral", phrase: null };
}

function keywordAnalyze(policyDocs, claimText) {
  const corpus = policyDocs
    .map((d) => `\n\n--- ${d.name} ---\n${d.text}`)
    .join("\n");
  const terms = topTerms(claimText, 10);
  const phraseMatches = (claimText.match(/[A-Z][a-z]+(?:\s+[A-Za-z]+){1,4}/g) || [])
    .map((p) => p.toLowerCase())
    .slice(0, 8);
  const allTerms = Array.from(new Set([...terms, ...phraseMatches]));

  const snippets = findSnippets(corpus, allTerms, 12).map((s) => ({
    ...s,
    classification: classifySnippet(s),
  }));

  const exclusions = snippets.filter(
    (s) => s.classification.kind === "exclusion"
  );
  const coverages = snippets.filter((s) => s.classification.kind === "coverage");

  let verdict = "uncertain";
  let confidence = 0.3;
  let citations = [];
  let reasoning = "";

  if (exclusions.length > 0 && coverages.length === 0) {
    verdict = "denied";
    confidence = Math.min(0.85, 0.5 + 0.1 * exclusions.length);
    citations = exclusions.slice(0, 3);
    reasoning =
      "The policy text contains exclusion language for terms appearing on this claim, and no clear coverage language was found.";
  } else if (coverages.length > 0 && exclusions.length === 0) {
    verdict = "covered";
    confidence = Math.min(0.8, 0.45 + 0.1 * coverages.length);
    citations = coverages.slice(0, 3);
    reasoning =
      "The policy text contains coverage language for terms appearing on this claim, and no exclusion language was found.";
  } else if (coverages.length > 0 && exclusions.length > 0) {
    verdict = "uncertain";
    confidence = 0.5;
    citations = [...exclusions.slice(0, 2), ...coverages.slice(0, 2)];
    reasoning =
      "Both coverage and exclusion language were found that match terms from this claim. A human review is recommended.";
  } else {
    verdict = "uncertain";
    confidence = 0.2;
    citations = snippets.slice(0, 3);
    reasoning =
      "No strong coverage or exclusion language was matched by the offline engine.";
  }

  return {
    verdict,
    confidence,
    reasoning,
    citations,
    engine: "keyword",
    matchedTerms: allTerms,
  };
}

// ------------- server-side Claude analysis ---------------------------------
async function serverAnalyze({ policyDocs, claimText }) {
  const resp = await fetch("/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      policyDocs: policyDocs.map((d) => ({ name: d.name, text: d.text })),
      claimText,
    }),
  });
  if (!resp.ok) {
    let detail = "";
    try {
      const j = await resp.json();
      detail = j.error || JSON.stringify(j);
    } catch {
      detail = await resp.text();
    }
    throw new Error(`Server analysis failed (${resp.status}): ${detail}`);
  }
  return await resp.json();
}

// ------------- UI helpers --------------------------------------------------
function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

const verdictMeta = {
  covered: {
    bg: "bg-emerald-600",
    text: "text-white",
    Icon: ShieldCheck,
    headline: "Claim appears COVERED",
    sub: "Based on the language in your policy, this charge looks like it falls within your benefits.",
  },
  denied: {
    bg: "bg-rose-600",
    text: "text-white",
    Icon: ShieldAlert,
    headline: "Claim appears NOT COVERED",
    sub: "Your policy contains language that appears to exclude or deny this charge.",
  },
  uncertain: {
    bg: "bg-amber-500",
    text: "text-white",
    Icon: AlertTriangle,
    headline: "Result is UNCERTAIN",
    sub: "The policy did not contain clear coverage or exclusion language for this charge.",
  },
};

// ------------- Main component ----------------------------------------------
export default function App() {
  const [policyDocs, setPolicyDocs] = useState([]);
  const [claim, setClaim] = useState({ name: "", text: "", status: "idle" });
  const [pastedClaim, setPastedClaim] = useState("");
  const [pastedPolicy, setPastedPolicy] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState({ msg: "", pct: 0 });
  const [showAllCitations, setShowAllCitations] = useState(false);

  const policyInputRef = useRef(null);
  const claimInputRef = useRef(null);

  const policyTextLength = useMemo(
    () => policyDocs.reduce((sum, d) => sum + (d.text?.length || 0), 0),
    [policyDocs]
  );

  const canAnalyze =
    policyDocs.some((d) => d.text && d.text.length > 50) &&
    ((claim.text && claim.text.length > 10) || pastedClaim.length > 10) &&
    !analyzing;

  async function handlePolicyFiles(fileList) {
    const files = Array.from(fileList);
    for (const f of files) {
      const id = `${f.name}-${f.size}-${Date.now()}-${Math.random()}`;
      setPolicyDocs((prev) => [
        ...prev,
        { id, name: f.name, size: f.size, text: "", status: "parsing" },
      ]);
      try {
        setProgress({ msg: `Reading ${f.name}…`, pct: 0 });
        const text = await extractText(f, (p) =>
          setProgress({ msg: `Reading ${f.name}…`, pct: p })
        );
        setPolicyDocs((prev) =>
          prev.map((d) =>
            d.id === id ? { ...d, text, status: "ready" } : d
          )
        );
      } catch (e) {
        setPolicyDocs((prev) =>
          prev.map((d) =>
            d.id === id
              ? { ...d, status: "error", text: "", error: e.message }
              : d
          )
        );
      }
    }
    setProgress({ msg: "", pct: 0 });
  }

  async function handleClaimFile(file) {
    if (!file) return;
    setClaim({ name: file.name, text: "", status: "parsing" });
    setError(null);
    try {
      setProgress({ msg: `Reading ${file.name}…`, pct: 0 });
      const text = await extractText(file, (p) =>
        setProgress({ msg: `Reading ${file.name}…`, pct: p })
      );
      setClaim({ name: file.name, text, status: "ready" });
    } catch (e) {
      setClaim({ name: file.name, text: "", status: "error" });
      setError(`Could not read ${file.name}: ${e.message}`);
    }
    setProgress({ msg: "", pct: 0 });
  }

  function addPastedPolicy() {
    if (!pastedPolicy.trim()) return;
    setPolicyDocs((prev) => [
      ...prev,
      {
        id: `pasted-${Date.now()}`,
        name: `Pasted policy text #${prev.length + 1}`,
        size: pastedPolicy.length,
        text: pastedPolicy,
        status: "ready",
      },
    ]);
    setPastedPolicy("");
  }

  function removePolicyDoc(id) {
    setPolicyDocs((prev) => prev.filter((d) => d.id !== id));
  }

  async function runAnalysis() {
    setAnalyzing(true);
    setResult(null);
    setError(null);
    const claimText = claim.text || pastedClaim;
    try {
      let res;
      setProgress({ msg: "Analyzing claim against your policy…", pct: 0.5 });
      try {
        res = await serverAnalyze({ policyDocs, claimText });
      } catch (e) {
        console.warn("Server analysis failed, using keyword fallback:", e);
        setError(
          `Semantic analysis unavailable — falling back to offline keyword scan. (${e.message})`
        );
        res = keywordAnalyze(policyDocs, claimText);
      }
      setResult(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setAnalyzing(false);
      setProgress({ msg: "", pct: 0 });
    }
  }

  function reset() {
    setResult(null);
    setError(null);
  }

  function startOver() {
    setPolicyDocs([]);
    setClaim({ name: "", text: "", status: "idle" });
    setPastedClaim("");
    setPastedPolicy("");
    setResult(null);
    setError(null);
  }

  // -------- RESULT SCREEN ------------------------------------------------
  if (result) {
    const meta = verdictMeta[result.verdict] || verdictMeta.uncertain;
    const Icon = meta.Icon;
    const cites = showAllCitations
      ? result.citations
      : result.citations.slice(0, 2);
    return (
      <div className={`min-h-screen ${meta.bg} ${meta.text} print-results`}>
        <div className="max-w-3xl mx-auto p-6 sm:p-10">
          <div className="flex items-center gap-3 mb-4 opacity-90">
            <Icon className="w-10 h-10" />
            <span className="text-sm uppercase tracking-widest font-semibold">
              Insurance Claim Checker
            </span>
          </div>

          <h1 className="text-4xl sm:text-5xl font-bold leading-tight mb-3">
            {meta.headline}
          </h1>
          <p className="text-lg opacity-90 mb-8">{meta.sub}</p>

          <div className="bg-white/15 backdrop-blur rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm uppercase tracking-wide font-semibold opacity-90">
                Why
              </div>
              <div className="text-xs opacity-80 flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5" />
                {result.engine === "claude"
                  ? "Analyzed by Claude"
                  : "Offline keyword engine"}
                {" · "}
                Confidence {Math.round(result.confidence * 100)}%
              </div>
            </div>
            <p className="leading-relaxed">{result.reasoning}</p>
          </div>

          <div className="bg-white text-slate-900 rounded-xl p-5 shadow-lg">
            <div className="flex items-center gap-2 mb-3">
              <FileText className="w-4 h-4 text-slate-500" />
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">
                Policy language found ({result.citations.length})
              </h2>
            </div>
            {result.citations.length === 0 ? (
              <p className="text-slate-500 italic">
                No specific policy passages were extracted.
              </p>
            ) : (
              <ul className="space-y-3">
                {cites.map((c, i) => {
                  const kind = c.classification?.kind || "neutral";
                  const KindIcon =
                    kind === "exclusion"
                      ? XCircle
                      : kind === "coverage"
                      ? CheckCircle2
                      : Info;
                  const kindColor =
                    kind === "exclusion"
                      ? "text-rose-600"
                      : kind === "coverage"
                      ? "text-emerald-600"
                      : "text-slate-500";
                  return (
                    <li
                      key={i}
                      className="border-l-4 pl-3 py-1 border-slate-200"
                    >
                      <div className="flex items-center gap-2 text-xs uppercase tracking-wide font-semibold mb-1">
                        <KindIcon className={`w-3.5 h-3.5 ${kindColor}`} />
                        <span className={kindColor}>{kind}</span>
                        {c.document && (
                          <span className="text-slate-400 normal-case font-normal">
                            · {c.document}
                          </span>
                        )}
                      </div>
                      <blockquote className="text-slate-800 italic">
                        “{c.sentence}”
                      </blockquote>
                    </li>
                  );
                })}
              </ul>
            )}
            {result.citations.length > 2 && (
              <button
                onClick={() => setShowAllCitations((v) => !v)}
                className="mt-4 text-sm text-slate-600 hover:text-slate-900 flex items-center gap-1"
              >
                {showAllCitations ? (
                  <>
                    <ChevronUp className="w-4 h-4" /> Show fewer
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-4 h-4" /> Show all{" "}
                    {result.citations.length}
                  </>
                )}
              </button>
            )}
          </div>

          <div className="mt-6 flex flex-wrap gap-3 print:hidden">
            <button
              onClick={reset}
              className="bg-white/20 hover:bg-white/30 backdrop-blur px-5 py-2.5 rounded-lg font-semibold flex items-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              Check another claim
            </button>
            <button
              onClick={() => window.print()}
              className="bg-white/20 hover:bg-white/30 backdrop-blur px-5 py-2.5 rounded-lg font-semibold flex items-center gap-2"
            >
              <Printer className="w-4 h-4" />
              Print results
            </button>
            <button
              onClick={startOver}
              className="bg-black/20 hover:bg-black/30 px-5 py-2.5 rounded-lg font-semibold"
            >
              Start over (clear everything)
            </button>
          </div>

          <p className="mt-8 text-xs opacity-75 leading-relaxed max-w-prose">
            This tool is a decision-support aid, not legal or medical advice.
            Insurance contracts are complex and the wording extracted here may
            be incomplete. Always confirm coverage decisions with your insurer
            before relying on them.
          </p>
        </div>
      </div>
    );
  }

  // -------- SETUP / UPLOAD SCREEN ----------------------------------------
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="max-w-4xl mx-auto p-6 sm:p-10">
        <header className="mb-8">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 text-white w-12 h-12 rounded-xl flex items-center justify-center">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold">
                Insurance Claim Checker
              </h1>
              <p className="text-slate-600 text-sm">
                Upload your policy, then a bill or EOB. Get a quick read on
                whether the charges are within your coverage.
              </p>
            </div>
          </div>
        </header>

        <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="bg-blue-100 text-blue-700 w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold">
                1
              </span>
              Insurance policy documents
            </h2>
            <span className="text-xs text-slate-500">
              {policyDocs.length} file{policyDocs.length === 1 ? "" : "s"} ·{" "}
              {policyTextLength.toLocaleString()} chars indexed
            </span>
          </div>
          <p className="text-sm text-slate-600 mb-4">
            Upload your Summary of Benefits, Evidence of Coverage, plan
            handbook — anything that describes what your insurance covers and
            excludes. The more you upload, the better the analysis.
          </p>

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handlePolicyFiles(e.dataTransfer.files);
            }}
            onClick={() => policyInputRef.current?.click()}
            className="border-2 border-dashed border-slate-300 hover:border-blue-400 rounded-xl p-6 text-center cursor-pointer transition-colors bg-slate-50"
          >
            <Upload className="w-8 h-8 mx-auto text-slate-400 mb-2" />
            <div className="font-medium">
              Drop policy files here, or click to browse
            </div>
            <div className="text-xs text-slate-500 mt-1">
              PDF · DOCX · TXT · JPG / PNG (OCR)
            </div>
            <input
              ref={policyInputRef}
              type="file"
              multiple
              accept=".pdf,.docx,.txt,image/*"
              className="hidden"
              onChange={(e) => handlePolicyFiles(e.target.files)}
            />
          </div>

          {policyDocs.length > 0 && (
            <ul className="mt-4 divide-y divide-slate-100">
              {policyDocs.map((d) => (
                <li key={d.id} className="py-3 flex items-center gap-3">
                  <FileText className="w-5 h-5 text-slate-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{d.name}</div>
                    <div className="text-xs text-slate-500">
                      {d.status === "parsing" && (
                        <span className="inline-flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Reading…
                        </span>
                      )}
                      {d.status === "ready" && (
                        <>
                          {fmtBytes(d.size)} · {d.text.length.toLocaleString()}{" "}
                          chars extracted
                        </>
                      )}
                      {d.status === "error" && (
                        <span className="text-rose-600">
                          Failed to parse: {d.error}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => removePolicyDoc(d.id)}
                    className="text-slate-400 hover:text-rose-600 p-1"
                    title="Remove"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <details className="mt-4 group">
            <summary className="text-sm text-blue-700 cursor-pointer hover:underline flex items-center gap-1">
              <ClipboardPaste className="w-4 h-4" />
              Or paste policy text directly
            </summary>
            <div className="mt-3">
              <textarea
                value={pastedPolicy}
                onChange={(e) => setPastedPolicy(e.target.value)}
                rows={5}
                placeholder="Paste a section of your insurance policy here — e.g. covered services, exclusions, limitations…"
                className="w-full border border-slate-300 rounded-lg p-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={addPastedPolicy}
                disabled={!pastedPolicy.trim()}
                className="mt-2 bg-slate-800 hover:bg-slate-900 disabled:bg-slate-300 text-white px-4 py-2 rounded-lg text-sm font-medium"
              >
                Add as policy text
              </button>
            </div>
          </details>
        </section>

        <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-1">
            <span className="bg-blue-100 text-blue-700 w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold">
              2
            </span>
            EOB or doctor's bill to check
          </h2>
          <p className="text-sm text-slate-600 mb-4">
            Upload the Explanation of Benefits or itemized bill you want to
            verify against your policy.
          </p>

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleClaimFile(e.dataTransfer.files[0]);
            }}
            onClick={() => claimInputRef.current?.click()}
            className="border-2 border-dashed border-slate-300 hover:border-blue-400 rounded-xl p-6 text-center cursor-pointer transition-colors bg-slate-50"
          >
            <Upload className="w-8 h-8 mx-auto text-slate-400 mb-2" />
            <div className="font-medium">
              {claim.name
                ? `Replace: ${claim.name}`
                : "Drop the EOB or bill here, or click to browse"}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              PDF · DOCX · TXT · JPG / PNG (OCR)
            </div>
            <input
              ref={claimInputRef}
              type="file"
              accept=".pdf,.docx,.txt,image/*"
              className="hidden"
              onChange={(e) => handleClaimFile(e.target.files?.[0])}
            />
          </div>

          {claim.name && (
            <div className="mt-3 flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
              <FileText className="w-5 h-5 text-slate-400" />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{claim.name}</div>
                <div className="text-xs text-slate-500">
                  {claim.status === "parsing" && (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Reading…
                    </span>
                  )}
                  {claim.status === "ready" && (
                    <>{claim.text.length.toLocaleString()} chars extracted</>
                  )}
                  {claim.status === "error" && (
                    <span className="text-rose-600">Could not read file</span>
                  )}
                </div>
              </div>
              <button
                onClick={() =>
                  setClaim({ name: "", text: "", status: "idle" })
                }
                className="text-slate-400 hover:text-rose-600 p-1"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          )}

          <details className="mt-4">
            <summary className="text-sm text-blue-700 cursor-pointer hover:underline flex items-center gap-1">
              <ClipboardPaste className="w-4 h-4" />
              Or paste claim/EOB text
            </summary>
            <textarea
              value={pastedClaim}
              onChange={(e) => setPastedClaim(e.target.value)}
              rows={5}
              placeholder="Paste the contents of the bill or EOB — procedure codes, descriptions, charges…"
              className="mt-2 w-full border border-slate-300 rounded-lg p-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </details>
        </section>

        {error && (
          <div className="mb-4 p-4 bg-rose-50 border border-rose-200 rounded-lg text-sm text-rose-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>{error}</div>
          </div>
        )}
        {progress.msg && (
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{progress.msg}</span>
            {progress.pct > 0 && (
              <span className="ml-auto text-xs">
                {Math.round(progress.pct * 100)}%
              </span>
            )}
          </div>
        )}

        <button
          onClick={runAnalysis}
          disabled={!canAnalyze}
          className={`w-full py-4 rounded-xl font-semibold text-lg flex items-center justify-center gap-2 transition-colors ${
            canAnalyze
              ? "bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-600/20"
              : "bg-slate-200 text-slate-400 cursor-not-allowed"
          }`}
        >
          {analyzing ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Analyzing…
            </>
          ) : (
            <>
              <Search className="w-5 h-5" />
              Analyze claim against policy
            </>
          )}
        </button>

        {!canAnalyze && !analyzing && (
          <p className="text-xs text-slate-500 text-center mt-3">
            {policyDocs.length === 0
              ? "Upload at least one policy document to begin."
              : !policyDocs.some((d) => d.text && d.text.length > 50)
              ? "Waiting for policy text to finish parsing…"
              : !claim.text && !pastedClaim
              ? "Add the EOB or bill you want to check."
              : ""}
          </p>
        )}

        <footer className="mt-12 text-center text-xs text-slate-400 leading-relaxed max-w-prose mx-auto">
          Decision-support tool only. Not legal, medical, or insurance advice.
          Always verify coverage decisions with your insurer.
          <br />
          Your documents are sent to the server only when you click Analyze,
          and are never stored.
        </footer>
      </div>
    </div>
  );
}
