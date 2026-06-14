/**
 * SessionPort — capture.js
 * Цикл захвата JSON-слепка из ответа LLM.
 * 3 ветки: code-блоки, BEGIN/END маркеры, голый JSON (Grok).
 * Зависимости: inject.js, adapters.js
 */

let captureInterval   = null;
let captureTimeout    = null;
let captureSessionId  = 0;
let seenBlocks        = new Set();
let _captureStartTextLen = 0;  // text length of last assistant msg at capture start

// ── Запуск ─────────────────────────────────────────────────
function startCapture() {
  stopCapture();
  captureSessionId++;
  const session = captureSessionId;

  setBadge('CAPTURING');
  showToast('Жду финальный JSON от модели…', 'info');

  // CRITICAL FIX: snapshot ALL existing code blocks as "seen"
  // so we only capture NEW blocks that appear after this point.
  // This prevents re-capturing old JSON snapshots from earlier in the dialogue.
  seenBlocks = new Set();
  for (const block of document.querySelectorAll(SELECTORS.CODE_BLOCKS)) {
    const content = block.textContent.replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '').trim();
    const fp = content.length + ':' + content.slice(0, 50) + ':' + content.slice(-100);
    seenBlocks.add(fp);
  }

  // Also snapshot current text length of last assistant message for Branch 2/3 filtering
  const lastMsg = findLastAssistantMessage();
  _captureStartTextLen = lastMsg ? (lastMsg.innerText || '').length : 0;

  captureInterval = setInterval(() => {
    if (session !== captureSessionId) return;
    tryCapture();
  }, CAPTURE_POLL_MS);

  setTimeout(() => { if (session === captureSessionId) tryCapture(); }, 3000);

  // Mid-capture sanity check: if model selector is broken after 30s, warn early
  setTimeout(() => {
    if (session !== captureSessionId) return;
    if (!findLastAssistantMessage()) {
      showToast('Сообщения модели не найдены — возможно, интерфейс платформы обновился. Обновите страницу.', 'error');
    }
  }, 30_000);

  captureTimeout = setTimeout(() => {
    if (session !== captureSessionId) return;
    stopCapture(); setBadge('ERROR');
    showToast('Захват прерван (2 мин): JSON не появился. Убедитесь что модель ответила на промпт SessionPort.', 'error');
    chrome.storage.local.get(['flow_state'], r => {
      chrome.storage.local.set({
        flow_state: { status:'IDLE', payload:null, mode: r.flow_state?.mode||null, step: r.flow_state?.step||0 }
      });
    });
  }, CAPTURE_TIMEOUT_MS);
}

// ── Остановка ───────────────────────────────────────────────
function stopCapture() {
  if (captureInterval) { clearInterval(captureInterval); captureInterval = null; }
  clearTimeout(captureTimeout); captureTimeout = null;
  seenBlocks.clear();
  _captureStartTextLen = 0;
}

// ── Ручной захват (SCAN NOW) ─────────────────────────────────
// One-shot: сканирует страницу прямо сейчас без запуска интервала.
// Используется кнопкой «Захватить вручную» и как fallback.
function captureNow() {
  // Reset seen/length so we scan everything on page
  seenBlocks.clear();
  _captureStartTextLen = 0;
  setBadge('CAPTURING');
  showToast('Сканирую страницу…', 'info');
  tryCapture();
  // Try a few more times in case page is still rendering
  let attempts = 0;
  const poll = setInterval(() => {
    attempts++;
    tryCapture();
    if (attempts >= 10) {
      clearInterval(poll);
      // If still not captured after 10 tries
      chrome.storage.local.get(['flow_state'], r => {
        if (r.flow_state?.status !== 'READY_TO_INJECT') {
          setBadge('ERROR');
          const hasMsg = !!findLastAssistantMessage();
          showToast(
            hasMsg
              ? 'SessionPort JSON не найден. Убедитесь что модель ответила на промпт — или попробуйте Full Transfer.'
              : 'Сообщения модели не найдены — возможно, интерфейс платформы обновился. Обновите страницу и попробуйте снова.',
            'error'
          );
        }
      });
    }
  }, 500);
}

// ── Основная попытка захвата ─────────────────────────────
function tryCapture() {

  // ══ Ветка 1: code-блоки (```json ... ```) ══
  const _lastMsg = findLastAssistantMessage();
  const _allBlocks = Array.from(document.querySelectorAll(SELECTORS.CODE_BLOCKS));
  const _filtered = _lastMsg ? _allBlocks.filter(b => _lastMsg.contains(b) || _lastMsg === b) : _allBlocks;
  const _blocksToScan = (_lastMsg && _filtered.length === 0) ? _allBlocks : _filtered;
  for (const block of _blocksToScan) {
    const content = block.textContent
      .replace(/[﻿​‌‍⁠]/g, '').trim();
    const fp = content.length + ':' + content.slice(0, 50) + ':' + content.slice(-100);
    if (seenBlocks.has(fp)) continue;
    if (seenBlocks.size > 500) {
      const first = seenBlocks.values().next().value;
      seenBlocks.delete(first);
    }
    if (!content.startsWith('{') || !content.endsWith('}')) continue;
    if (new TextEncoder().encode(content).length > MAX_JSON_BYTES) {
      showToast('JSON >500KB — захват отменён', 'error');
      seenBlocks.add(fp); stopCapture(); setBadge('ERROR'); return;
    }
    try {
      const parsed = JSON.parse(content);
      if (_notSessionPort(parsed)) continue;
      const isV11 = parsed?.meta?.version === '1.1';
      const requiredFields = isV11
        ? ['meta','dna','decisions','state','instructions','validation']
        : ['meta','core','ledger','runtime','validation_protocol'];
      const miss = requiredFields.filter(k => !parsed[k]);
      if (miss.length > 0) { console.warn('[PR] Пропущены поля:', miss.join(',')); continue; }
      if (_isTemplatePlaceholder(parsed)) { continue; }
      _saveAndStop(content, parsed);
      return;
    } catch (e) {
      if (!(e instanceof SyntaxError)) console.error("[PR] Unexpected capture error:", e);
      /* partial JSON — continue polling */
    }
  }

  // ══ Ветка 2+3: общие переменные — объявляем ДО Branch 2 return'ов ══
  const root    = findLastAssistantMessage();
  const fullTxt = root ? (root.innerText || root.textContent || '') : '';
  // Sliced: new text since capture started
  // If message is entirely new OR slice gives nothing — use full message
  const sliced  = (fullTxt.length > _captureStartTextLen)
    ? fullTxt.slice(_captureStartTextLen)
    : fullTxt;
  const txt = sliced.length > 0 ? sliced : fullTxt;

  // ══ Ветка 2: BEGIN/END маркеры ══
  if (root && txt) {
    const BM = '---BEGIN CONTEXT---';
    const EM = '---END CONTEXT---';
    const bi = txt.lastIndexOf(BM);
    const ei = txt.lastIndexOf(EM);

    if (bi !== -1 && ei > bi) {
      const cand = cleanJsonCandidate(txt.slice(bi + BM.length, ei).trim());
      let parsed;
      try { parsed = JSON.parse(cand); }
      catch {
        try { parsed = JSON.parse(cand.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")); }
        catch { /* fall through */ }
      }
      if (parsed && !_notSessionPort(parsed)) {
        const isV11b2 = parsed?.meta?.version === '1.1';
        const reqB2 = isV11b2
          ? ['meta','dna','decisions','state']
          : ['meta','core','ledger','runtime'];
        if (reqB2.every(k => parsed[k])) {
          if (new TextEncoder().encode(cand).length > MAX_JSON_BYTES) {
            showToast('JSON >500KB — захват отменён', 'error'); stopCapture(); setBadge('ERROR'); return;
          }
          _saveAndStop(cand, parsed);
          return;
        }
      }
    }
  }

  // ══ Ветка 3: голый JSON (plain text, Grok / ChatGPT без code-блока) ══
  const PROTO_MARKER = '{"meta":{"protocol":"SessionPort"';
  // Search in sliced txt first (new content since capture start)
  // Fallback: search in full last assistant message (handles case where
  // the whole response IS the new message and slice calculation was off)
  let b3start = txt.indexOf(PROTO_MARKER);
  if (b3start === -1) {
    const lo = txt.toLowerCase();
    const li = lo.indexOf('{"meta":{"protocol":"sessionport"');
    if (li !== -1) b3start = li;
  }
  // Fallback: try full message text
  if (b3start === -1) {
    const fb3start = fullTxt.indexOf(PROTO_MARKER);
    const fb3lo    = fullTxt.toLowerCase().indexOf('{"meta":{"protocol":"sessionport"');
    const fb3      = fb3start !== -1 ? fb3start : fb3lo;
    if (fb3 !== -1) {
      // Only use if this position changed since last poll (text grew)
      // i.e. the JSON appeared or grew since capture started
      if (fullTxt.length > _captureStartTextLen) {
        b3start = fb3;
      }
    }
  }
  if (b3start === -1) return;

  // Найти парную закрывающую скобку
  let depth = 0, b3end = -1;
  for (let i = b3start; i < txt.length; i++) {
    if (txt[i] === '{') depth++;
    else if (txt[i] === '}') { depth--; if (depth === 0) { b3end = i; break; } }
  }
  // JSON ещё не дописан (стриминг)
  if (b3end === -1 || depth !== 0) return;

  const jsonCand = cleanJsonCandidate(txt.slice(b3start, b3end + 1));
  let p3;
  try { p3 = JSON.parse(jsonCand); }
  catch {
    try { p3 = JSON.parse(jsonCand.replace(/[""]/g, '"').replace(/['']/g, "'")); }
    catch { return; }
  }
  if (_notSessionPort(p3)) return;
  const isV11b3 = p3?.meta?.version === '1.1';
  const reqB3 = isV11b3 ? ['meta','dna','decisions','state'] : ['meta','core','ledger','runtime'];
  if (!reqB3.every(k => p3[k])) return;

  const b3bytes = new TextEncoder().encode(jsonCand).length;
  if (b3bytes > MAX_JSON_BYTES) {
    seenBlocks.add(b3start + ':' + b3end);
    showToast('JSON >500KB — захват отменён', 'error'); stopCapture(); setBadge('ERROR'); return;
  }
  _saveAndStop(jsonCand, p3);
}

// ── Внутренние хелперы ───────────────────────────────────
function _notSessionPort(parsed) {
  return String(parsed?.meta?.protocol || '').trim().toLowerCase() !== 'sessionport';
}


function _isTemplatePlaceholder(parsed) {
  if (parsed?.dna?.goal?.endsWith('(глагол+задача+приоритет)')) return true;
  if (parsed?.state?.current_task === '…') return true;
  if (parsed?.state?.next_step    === '…') return true;
  const d = parsed?.decisions;
  if (Array.isArray(d) && d.length > 0 && d.every(x => x.what === '…' || x.what === '...')) return true;
  if (parsed?.core?.intent === 'инструкция-продолжение (глагол+задача+приоритет)') return true;
  if (parsed?.runtime?.current_status === '…') return true;
  return false;
}

function _saveAndStop(jsonStr, parsed) {
  const b64 = utf8ToBase64(jsonStr);
  // Preserve existing mode/step — don't overwrite with null/0
  chrome.storage.local.get(['flow_state'], res => {
    const prev = res.flow_state || {};
    chrome.storage.local.set({
      flow_state: {
        status: 'READY_TO_INJECT',
        payload: b64,
        source_host: location.hostname,
        mode: prev.mode || null,
        step: prev.step || 0
      }
    });
  });
  safeSendMessage({ action: 'SAVE_SNAPSHOT', payload: parsed, source_host: location.hostname },
    (response) => {
      if (!response?.success && response?.code === 'QUOTA_EXCEEDED') {
        showToast('Хранилище заполнено — удалите старые слепки', 'error');
      }
    }
  );
  stopCapture(); setBadge('READY'); showToast('Контекст захвачен!', 'success');
}

// ── JSON cleaner ─────────────────────────────────────────
function cleanJsonCandidate(raw) {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  s = s.replace(/^json\s*\n?/i, '');
  s = s.replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '');
  // Grok/innerText вставляет голые \n внутри JSON-строк — экранируем
  s = s.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, content) => {
    return '"' + content
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t') + '"';
  });
  return s.trim();
}

// ── Transfer prompt builder ──────────────────────────────
const _RESTORE_INTRO = {
  en: `SessionPort PROTOCOL — CONTEXT RESTORATION.

Read the snapshot layer by layer and restore the working context:
1. meta + dna — accept as project identity (goal, language, style, constraints, trajectory — where the project is heading)
2. decisions — memorize all. type:"rejected" — never suggest again, the reason is in "why"
3. state — continue from here. state.next_step — your first action
4. instructions — follow as your own rules
5. open_threads (if present) — unresolved questions; keep them live, do not treat them as closed
6. implicit (if present): calibrate style and detail from user_profile; honor adaptation_log — do not re-suggest what the user already abandoned; assumptions by confidence — low: do not act silently, ask first; medium: act but flag the assumption in your first reply; high: accept as fact

Rely only on the snapshot. If something needed for the next step is missing, ask — do not invent it.

First, in one line, confirm where we left off: goal + next step. Then answer the questions from validation.questions — answers must match validation.expected; if not, re-read the snapshot. After that, continue the work.`,
  ru: `ПРОТОКОЛ SessionPort — ВОССТАНОВЛЕНИЕ КОНТЕКСТА.

Прочитай слепок послойно и восстанови рабочий контекст:
1. meta + dna — прими как идентичность проекта (цель, язык, стиль, ограничения, trajectory — куда движется проект)
2. decisions — запомни все. type:"rejected" — никогда не предлагай повторно, причина в "why"
3. state — продолжай отсюда. state.next_step — твоё первое действие
4. instructions — следуй как собственным правилам
5. open_threads (если есть) — нерешённые вопросы; держи их в работе, не считай закрытыми
6. implicit (если есть): откалибруй стиль и детальность по user_profile; соблюдай adaptation_log — не предлагай заново то, от чего пользователь уже отказался; assumptions по confidence — low: не действуй молча, сначала уточни; medium: действуй, но отметь допущение в первом ответе; high: прими как факт

Опирайся только на данные слепка. Если для следующего шага чего-то не хватает — спроси, не выдумывай.

Сначала одной строкой подтверди, где мы остановились: цель + следующий шаг. Затем ответь на вопросы из validation.questions — ответы должны соответствовать validation.expected; если нет, перечитай слепок. После этого продолжай работу.`,
  de: `SessionPort PROTOKOLL — KONTEXT-WIEDERHERSTELLUNG.

Lies den Snapshot Schicht für Schicht und stelle den Arbeitskontext wieder her:
1. meta + dna — als Projektidentität übernehmen (Ziel, Sprache, Stil, Einschränkungen, trajectory — wohin sich das Projekt bewegt)
2. decisions — alle merken. type:"rejected" — nie wieder vorschlagen, der Grund steht in "why"
3. state — hier fortfahren. state.next_step — deine erste Aktion
4. instructions — als eigene Regeln befolgen
5. open_threads (falls vorhanden) — ungelöste Fragen; halte sie aktiv, betrachte sie nicht als abgeschlossen
6. implicit (falls vorhanden): Stil und Detailgrad aus user_profile kalibrieren; adaptation_log beachten — schlage nicht erneut vor, was der Nutzer bereits aufgegeben hat; assumptions nach confidence — low: nicht stillschweigend handeln, erst nachfragen; medium: handeln, aber die Annahme in deiner ersten Antwort kennzeichnen; high: als Fakt akzeptieren

Stütze dich nur auf den Snapshot. Fehlt etwas für den nächsten Schritt — frage nach, erfinde nichts.

Bestätige zuerst in einer Zeile, wo wir stehen geblieben sind: Ziel + nächster Schritt. Beantworte dann die Fragen aus validation.questions — die Antworten müssen validation.expected entsprechen; falls nicht, lies den Snapshot erneut. Fahre danach mit der Arbeit fort.`,
  fr: `PROTOCOLE SessionPort — RESTAURATION DU CONTEXTE.

Lis le snapshot couche par couche et restaure le contexte de travail :
1. meta + dna — accepte comme identité du projet (objectif, langue, style, contraintes, trajectory — vers où va le projet)
2. decisions — mémorise toutes. type:"rejected" — ne plus jamais suggérer, la raison est dans "why"
3. state — continue à partir d'ici. state.next_step — ta première action
4. instructions — suis-les comme tes propres règles
5. open_threads (si présent) — questions non résolues ; garde-les actives, ne les considère pas comme closes
6. implicit (si présent) : calibre le style et le niveau de détail depuis user_profile ; respecte adaptation_log — ne re-suggère pas ce que l'utilisateur a déjà abandonné ; assumptions par confidence — low : n'agis pas en silence, demande d'abord ; medium : agis mais signale l'hypothèse dans ta première réponse ; high : accepte comme un fait

Appuie-toi uniquement sur le snapshot. S'il manque quelque chose pour l'étape suivante — demande, n'invente pas.

D'abord, en une ligne, confirme où nous en étions : objectif + prochaine étape. Puis réponds aux questions de validation.questions — les réponses doivent correspondre à validation.expected ; sinon, relis le snapshot. Ensuite, poursuis le travail.`,
  es: `PROTOCOLO SessionPort — RESTAURACIÓN DEL CONTEXTO.

Lee el snapshot capa por capa y restaura el contexto de trabajo:
1. meta + dna — acepta como identidad del proyecto (objetivo, idioma, estilo, restricciones, trajectory — hacia dónde va el proyecto)
2. decisions — memoriza todas. type:"rejected" — nunca volver a sugerir, la razón está en "why"
3. state — continúa desde aquí. state.next_step — tu primera acción
4. instructions — síguelas como tus propias reglas
5. open_threads (si está presente) — preguntas sin resolver; mantenlas activas, no las consideres cerradas
6. implicit (si está presente): calibra el estilo y el detalle desde user_profile; respeta adaptation_log — no vuelvas a sugerir lo que el usuario ya abandonó; assumptions por confidence — low: no actúes en silencio, pregunta primero; medium: actúa pero señala la suposición en tu primera respuesta; high: acéptalo como un hecho

Apóyate solo en el snapshot. Si falta algo para el siguiente paso — pregunta, no lo inventes.

Primero, en una línea, confirma dónde lo dejamos: objetivo + siguiente paso. Luego responde las preguntas de validation.questions — las respuestas deben coincidir con validation.expected; si no, vuelve a leer el snapshot. Después, continúa el trabajo.`,
  zh: `SessionPort 协议 — 上下文恢复。

逐层阅读快照并恢复工作上下文：
1. meta + dna — 作为项目身份接受（目标、语言、风格、约束、trajectory — 项目的走向）
2. decisions — 全部记住。type:"rejected" — 永不再建议，原因在 "why" 中
3. state — 从这里继续。state.next_step — 你的第一个动作
4. instructions — 作为你自己的规则遵守
5. open_threads（如果有）— 未解决的问题；保持其活跃，不要视为已关闭
6. implicit（如果有）：根据 user_profile 校准风格和详细程度；遵守 adaptation_log — 不要再次建议用户已经放弃的内容；assumptions 按 confidence — low：不要默默行动，先询问；medium：行动但在首次回复中标注该假设；high：作为事实接受

仅依据快照。如果下一步缺少所需信息 — 询问，不要编造。

首先用一行确认我们停在哪里：目标 + 下一步。然后回答 validation.questions 中的问题 — 答案必须符合 validation.expected；若不符，重新阅读快照。之后继续工作。`,
  ja: `SessionPort プロトコル — コンテキスト復元。

スナップショットをレイヤーごとに読み、作業コンテキストを復元してください：
1. meta + dna — プロジェクトのアイデンティティとして受け入れる（目標、言語、スタイル、制約、trajectory — プロジェクトの向かう先）
2. decisions — すべて記憶する。type:"rejected" — 二度と提案しない、理由は "why" にある
3. state — ここから続ける。state.next_step — あなたの最初のアクション
4. instructions — 自分自身のルールとして従う
5. open_threads（あれば）— 未解決の質問；アクティブに保ち、解決済みと見なさない
6. implicit（あれば）：user_profile からスタイルと詳細度を調整する；adaptation_log を尊重する — ユーザーが既に放棄したものを再提案しない；assumptions は confidence ごとに — low：黙って行動せず、まず尋ねる；medium：行動するが最初の返信でその仮定を明示する；high：事実として受け入れる

スナップショットのみに基づいてください。次のステップに必要なものが欠けている場合は — 尋ね、作り上げないでください。

まず1行で、どこまで進んだかを確認してください：目標 + 次のステップ。次に validation.questions の質問に答えてください — 答えは validation.expected と一致する必要があります；一致しない場合はスナップショットを読み直してください。その後、作業を続けてください。`,
  ko: `SessionPort 프로토콜 — 컨텍스트 복원.

스냅샷을 레이어별로 읽고 작업 컨텍스트를 복원하세요:
1. meta + dna — 프로젝트 정체성으로 수용 (목표, 언어, 스타일, 제약, trajectory — 프로젝트가 향하는 방향)
2. decisions — 모두 기억. type:"rejected" — 다시는 제안하지 말 것, 이유는 "why"에 있음
3. state — 여기서 계속. state.next_step — 당신의 첫 번째 행동
4. instructions — 자신의 규칙으로 따를 것
5. open_threads (있으면) — 미해결 질문; 살아있게 유지하고 종료된 것으로 취급하지 말 것
6. implicit (있으면): user_profile로 스타일과 detail을 보정; adaptation_log 준수 — 사용자가 이미 포기한 것을 다시 제안하지 말 것; assumptions는 confidence별로 — low: 조용히 행동하지 말고 먼저 질문; medium: 행동하되 첫 답변에서 가정을 표시; high: 사실로 수용

스냅샷에만 근거하세요. 다음 단계에 필요한 것이 빠져 있으면 — 물어보고, 지어내지 마세요.

먼저 한 줄로 우리가 어디까지 했는지 확인하세요: 목표 + 다음 단계. 그런 다음 validation.questions의 질문에 답하세요 — 답은 validation.expected와 일치해야 합니다; 그렇지 않으면 스냅샷을 다시 읽으세요. 그 후 작업을 계속하세요.`,
  pt: `PROTOCOLO SessionPort — RESTAURAÇÃO DO CONTEXTO.

Leia o snapshot camada por camada e restaure o contexto de trabalho:
1. meta + dna — aceite como identidade do projeto (objetivo, idioma, estilo, restrições, trajectory — para onde o projeto está indo)
2. decisions — memorize todas. type:"rejected" — nunca sugerir novamente, o motivo está em "why"
3. state — continue a partir daqui. state.next_step — sua primeira ação
4. instructions — siga como suas próprias regras
5. open_threads (se presente) — questões não resolvidas; mantenha-as ativas, não as considere encerradas
6. implicit (se presente): calibre o estilo e o detalhe a partir de user_profile; respeite adaptation_log — não sugira novamente o que o usuário já abandonou; assumptions por confidence — low: não aja em silêncio, pergunte primeiro; medium: aja mas sinalize a suposição na sua primeira resposta; high: aceite como fato

Baseie-se apenas no snapshot. Se faltar algo para o próximo passo — pergunte, não invente.

Primeiro, em uma linha, confirme onde paramos: objetivo + próximo passo. Depois responda às perguntas de validation.questions — as respostas devem corresponder a validation.expected; se não, releia o snapshot. Em seguida, continue o trabalho.`
};

function buildTransferPrompt(json) {
  const L = ['en','ru','de','fr','es','zh','ja','ko','pt'].includes(_lang) ? _lang : 'en';
  return `${_RESTORE_INTRO[L] || _RESTORE_INTRO.en}\n\n---BEGIN CONTEXT---\n${json}\n---END CONTEXT---`;
}

// ── Paste: wait for editor and inject ───────────────────
let injectObserver = null;
let injectTimeout  = null;

async function waitForEditorAndInject(b64) {
  if (injectObserver) { injectObserver.disconnect(); injectObserver = null; }
  clearTimeout(injectTimeout); injectTimeout = null;

  const input = getAdapter()?.findInput() || document.querySelector(SELECTORS.INPUTS);
  if (input) {
    const ok = await injectContext(buildTransferPrompt(base64ToUtf8(b64)));
    if (ok) {
      chrome.storage.local.set({ flow_state: { status: 'IDLE', payload: null, mode: null, step: 0 } });
      setBadge('IDLE');
    }
    return;
  }

  injectObserver = new MutationObserver((_, obs) => {
    const el = getAdapter()?.findInput() || document.querySelector(SELECTORS.INPUTS);
    if (!el) return;
    obs.disconnect(); injectObserver = null;
    clearTimeout(injectTimeout); injectTimeout = null;
    injectContext(buildTransferPrompt(base64ToUtf8(b64))).then(ok => {
      if (ok) {
        chrome.storage.local.set({ flow_state: { status: 'IDLE', payload: null, mode: null, step: 0 } });
        setBadge('IDLE');
      }
    });
  });
  injectObserver.observe(document.body, { childList: true, subtree: true });
  injectTimeout = setTimeout(() => {
    injectTimeout = null;
    if (injectObserver) { injectObserver.disconnect(); injectObserver = null; }
    showToast('Редактор не найден за 15с', 'error'); setBadge('ERROR');
  }, 15_000);
}
