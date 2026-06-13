/**
 * SessionPort — popup-shell.js
 * Точка входа popup: PROMPTS, router showScreen, map screen, main init.
 * Загружается последним среди popup-скриптов.
 *
 * Порядок тегов <script> в popup.html:
 *   db.js → shared-utils.js → popup-utils.js → map-renderer.js
 *   → projects.js → history.js → files.js → flow.js → popup-shell.js
 */

// ═══════════════════════════════════════════════════════════
// ПРОМПТЫ
// ═══════════════════════════════════════════════════════════
// FIX: single source of truth for protocol version
const PROTOCOL_VERSION = '1.1';  // JSON meta.version — update here when schema changes

function _lang() {
  const _ls = ['en','ru','de','fr','es','zh','ja','ko','pt'];
  return _ls.includes(PR_i18n.lang) ? PR_i18n.lang : 'en';
}

// PROMPTS as functions accepting transfer_id (UUID) and optional parent_transfer_id.
// transfer_id makes each capture session uniquely identifiable end-to-end:
// extension generates UUID → injects into prompt → model echoes in JSON → extension validates.
const PROMPTS = {
  // Step 1 (Simple): structured extraction — decisions with WHY, behavioral instructions.
  SIMPLE_ANALYZE: (transfer_id) => {
    const L = _lang();
    if (L === 'en') return `SessionPort PROTOCOL — QUICK TRANSFER.

First, answer one question: what from our current conversation will be LOST in the transfer? For each item: critical / acceptable / irrelevant. Only critical items go into the snapshot.

Then output strictly by sections:

## PROJECT DNA
- Domain, stack, goal — one instruction sentence (verb + task + priority)
- User's language and communication style (concise/verbose, language)
- Global constraints (technologies, restrictions, deadlines)

## DECISIONS
Each on its own line. Reason and context are required:
[ACCEPTED] what exactly — because reason — under what circumstances
[REJECTED] what exactly — because reason — why never suggest again
[RULE] what exactly — because reason
Minimum 3, ideally 5–10. Include ALL real [REJECTED] items — everything that was tried and explicitly refused. Do NOT invent rejections that didn't happen. If there were none, omit [REJECTED] entirely.

## STATE
Last 3–5 actions · what works / what's broken / what's in progress · next step.

## IMPLICIT BLOCKS
What did you stop suggesting in this session because the user silently rejected it? (implicit negative feedback — the most valuable thing lost in a transfer)

## INSTRUCTIONS FOR THE NEW MODEL
3–5 rules: "If [X] → [Y]" or "Always/Never [Z] — because [reason]".

⚠️ If context is partially lost — use Full Transfer for manual correction.`;
    if (L === 'de') return `SessionPort PROTOKOLL — SCHNELLTRANSFER.

Beantworte zuerst eine Frage: Was aus unserem aktuellen Gespräch geht beim Transfer VERLOREN? Für jeden Punkt: kritisch / akzeptabel / unwichtig. Nur Kritisches kommt in den Snapshot.

Dann gib strikt nach Abschnitten aus:

## PROJEKT-DNA
- Domäne, Stack, Ziel — ein Instruktionssatz (Verb + Aufgabe + Priorität)
- Sprache und Kommunikationsstil des Nutzers (knapp/ausführlich, Sprache)
- Globale Einschränkungen (Technologien, Verbote, Deadlines)

## ENTSCHEIDUNGEN
Jede in einer eigenen Zeile. Grund und Kontext sind Pflicht:
[ANGENOMMEN] was genau — weil Grund — unter welchen Umständen
[ABGELEHNT] was genau — weil Grund — warum nie wieder vorschlagen
[REGEL] was genau — weil Grund
Mindestens 3, idealerweise 5–10. Erfasse ALLE realen [ABGELEHNT]-Einträge — alles was versucht und ausdrücklich abgelehnt wurde. Erfinde KEINE Ablehnungen. Wenn es keine gab, lasse [ABGELEHNT] weg.

## ZUSTAND
Letzte 3–5 Aktionen · was funktioniert / was ist kaputt / was ist in Arbeit · nächster Schritt.

## IMPLIZITE VERBOTE
Was haben Sie in dieser Sitzung aufgehört vorzuschlagen, weil der Nutzer es stillschweigend ablehnte? (implizites negatives Feedback — das Wertvollste, das beim Transfer verloren geht)

## ANWEISUNGEN FÜR DAS NEUE MODELL
3–5 Regeln: „Wenn [X] → [Y]" oder „Immer/Nie [Z] — weil [Grund]".

⚠️ Wenn der Kontext teilweise verloren ist — nutze den Vollständigen Transfer zur manuellen Korrektur.`;
    if (L === 'fr') return `PROTOCOLE SessionPort — TRANSFERT RAPIDE.

Réponds d'abord à une question : qu'est-ce qui sera PERDU lors du transfert de notre conversation actuelle ? Pour chaque élément : critique / acceptable / sans importance. Seul le critique entre dans le snapshot.

Puis donne strictement par sections :

## ADN DU PROJET
- Domaine, stack, objectif — une phrase-instruction (verbe + tâche + priorité)
- Langue et style de communication de l'utilisateur (concis/verbeux, langue)
- Contraintes globales (technologies, interdictions, délais)

## DÉCISIONS
Chacune sur sa propre ligne. La raison et le contexte sont obligatoires :
[ACCEPTÉ] quoi exactement — parce que raison — dans quelles circonstances
[REJETÉ] quoi exactement — parce que raison — pourquoi ne plus suggérer
[RÈGLE] quoi exactement — parce que raison
Minimum 3, idéalement 5–10. Inclus TOUS les [REJETÉ] réels — tout ce qui a été essayé et explicitement refusé. N'invente PAS de rejets. S'il n'y en a pas eu, omets [REJETÉ] entièrement.

## ÉTAT
3–5 dernières actions · ce qui fonctionne / ce qui est cassé / ce qui est en cours · prochaine étape.

## BLOCAGES IMPLICITES
Qu'as-tu arrêté de suggérer dans cette session parce que l'utilisateur l'a silencieusement rejeté ? (feedback négatif implicite — la chose la plus précieuse perdue lors d'un transfert)

## INSTRUCTIONS POUR LE NOUVEAU MODÈLE
3–5 règles : « Si [X] → [Y] » ou « Toujours/Jamais [Z] — parce que [raison] ».

⚠️ Si le contexte est partiellement perdu — utilise le Transfert Complet pour une correction manuelle.`;
    if (L === 'es') return `PROTOCOLO SessionPort — TRANSFERENCIA RÁPIDA.

Primero responde una pregunta: ¿qué de nuestra conversación actual se PERDERÁ en la transferencia? Para cada elemento: crítico / aceptable / irrelevante. Solo lo crítico entra en el snapshot.

Luego proporciona estrictamente por secciones:

## ADN DEL PROYECTO
- Dominio, stack, objetivo — una oración-instrucción (verbo + tarea + prioridad)
- Idioma y estilo de comunicación del usuario (conciso/detallado, idioma)
- Restricciones globales (tecnologías, prohibiciones, plazos)

## DECISIONES
Cada una en su propia línea. La razón y el contexto son obligatorios:
[ACEPTADO] qué exactamente — porque razón — en qué circunstancias
[RECHAZADO] qué exactamente — porque razón — por qué no volver a sugerir
[REGLA] qué exactamente — porque razón
Mínimo 3, idealmente 5–10. Incluye TODOS los [RECHAZADO] reales — todo lo que se intentó y fue rechazado explícitamente. NO inventes rechazos. Si no hubo ninguno, omite [RECHAZADO] completamente.

## ESTADO
Últimas 3–5 acciones · qué funciona / qué está roto / qué está en progreso · siguiente paso.

## BLOQUEOS IMPLÍCITOS
¿Qué dejaste de sugerir en esta sesión porque el usuario lo rechazó silenciosamente? (feedback negativo implícito — lo más valioso que se pierde en una transferencia)

## INSTRUCCIONES PARA EL NUEVO MODELO
3–5 reglas: «Si [X] → [Y]» o «Siempre/Nunca [Z] — porque [razón]».

⚠️ Si el contexto se pierde parcialmente — usa la Transferencia Completa para corrección manual.`;
    if (L === 'zh') return `SessionPort 协议 — 快速传输。

首先回答一个问题：我们当前对话中有什么内容会在传输中丢失？每项分类：关键 / 可接受 / 无关紧要。只有关键内容进入快照。

然后按以下章节严格输出：

## 项目DNA
- 领域、技术栈、目标 — 一个指令句（动词+任务+优先级）
- 用户的语言和沟通风格（简洁/详细，语言）
- 全局约束（技术、禁止事项、截止日期）

## 决策
每项单独一行。原因和背景为必填：
[已采纳] 具体什么 — 因为原因 — 在什么情况下
[已拒绝] 具体什么 — 因为原因 — 为什么不再建议
[规则] 具体什么 — 因为原因
最少3条，理想5–10条。包含所有真实的[已拒绝]条目——所有被尝试并被明确拒绝的内容。不要编造拒绝。如果没有，完全省略[已拒绝]。

## 状态
最近3–5个操作 · 什么有效/什么损坏/什么进行中 · 下一步。

## 隐式禁区
在这次会话中，你因为用户默默拒绝而停止建议了什么？（隐式负反馈 — 传输中丢失的最有价值的内容）

## 新模型的指令
3–5条规则：「如果[X]→[Y]」或「总是/永不[Z]——因为[原因]」。

⚠️ 如果上下文部分丢失 — 使用完整传输进行手动校正。`;
    if (L === 'ja') return `SessionPort プロトコル — クイック転送。

まず1つの質問に答えてください：現在の会話から転送時に失われるものは何ですか？各項目について：重要 / 許容可能 / 無関係。重要なものだけがスナップショットに入ります。

次にセクションごとに厳密に出力してください：

## プロジェクトDNA
- ドメイン、スタック、目標 — 1つの指示文（動詞+タスク+優先度）
- ユーザーの言語とコミュニケーションスタイル（簡潔/詳細、言語）
- グローバル制約（技術、禁止事項、期限）

## 決定事項
それぞれ別の行に。理由とコンテキストは必須：
[採用] 具体的に何を — なぜ理由 — どのような状況で
[却下] 具体的に何を — なぜ理由 — なぜ再提案しないか
[ルール] 具体的に何を — なぜ理由
最低3つ、理想は5–10。実際の[却下]をすべて含めてください — 試みられ明示的に拒否されたすべてのもの。拒否を作り上げないでください。なかった場合は[却下]を完全に省略してください。

## 状態
最後の3–5つのアクション · 何が機能しているか/壊れているか/進行中か · 次のステップ。

## 暗黙のブロック
このセッションで、ユーザーが黙って拒否したために提案をやめたものは何ですか？（暗黙のネガティブフィードバック — 転送で失われる最も貴重なもの）

## 新しいモデルへの指示
3–5つのルール：「もし[X]→[Y]」または「常に/決して[Z] — なぜなら[理由]」。

⚠️ コンテキストが部分的に失われた場合 — 手動修正のためにフル転送を使用してください。`;
    if (L === 'ko') return `SessionPort 프로토콜 — 빠른 전송.

먼저 한 가지 질문에 답하세요: 현재 대화에서 전송 시 무엇이 손실됩니까? 각 항목에 대해: 중요 / 허용 가능 / 무관. 중요한 것만 스냅샷에 포함됩니다.

그런 다음 섹션별로 엄격하게 출력하세요:

## 프로젝트 DNA
- 도메인, 스택, 목표 — 하나의 지시 문장 (동사 + 작업 + 우선순위)
- 사용자의 언어 및 소통 스타일 (간결/장황, 언어)
- 전역 제약 (기술, 금지 사항, 마감일)

## 결정 사항
각각 별도의 줄에. 이유와 맥락은 필수:
[채택] 정확히 무엇을 — 이유 때문에 — 어떤 상황에서
[거부] 정확히 무엇을 — 이유 때문에 — 왜 다시 제안하지 않는가
[규칙] 정확히 무엇을 — 이유 때문에
최소 3개, 이상적으로는 5–10개. 실제 [거부] 항목을 모두 포함하세요 — 시도되었고 명시적으로 거부된 모든 것. 거부를 만들어내지 마세요. 없었다면 [거부]를 완전히 생략하세요.

## 상태
마지막 3–5개 작업 · 무엇이 작동하는가 / 무엇이 고장났는가 / 무엇이 진행 중인가 · 다음 단계.

## 암묵적 차단
사용자가 조용히 거부했기 때문에 이 세션에서 제안을 중단한 것은 무엇입니까? (암묵적 부정적 피드백 — 전송에서 잃어버리는 가장 귀중한 것)

## 새 모델에 대한 지시
3–5개 규칙: "만약 [X] → [Y]" 또는 "항상/절대로 [Z] — 왜냐하면 [이유]".

⚠️ 맥락이 부분적으로 손실된 경우 — 수동 수정을 위해 전체 전송을 사용하세요.`;
    if (L === 'pt') return `PROTOCOLO SessionPort — TRANSFERÊNCIA RÁPIDA.

Primeiro responda uma pergunta: o que da nossa conversa atual será PERDIDO na transferência? Para cada item: crítico / aceitável / irrelevante. Apenas o crítico entra no snapshot.

Em seguida, forneça estritamente por seções:

## DNA DO PROJETO
- Domínio, stack, objetivo — uma frase-instrução (verbo + tarefa + prioridade)
- Idioma e estilo de comunicação do usuário (conciso/detalhado, idioma)
- Restrições globais (tecnologias, proibições, prazos)

## DECISÕES
Cada uma em sua própria linha. Motivo e contexto são obrigatórios:
[ACEITO] o que exatamente — porque motivo — em que circunstâncias
[REJEITADO] o que exatamente — porque motivo — por que não sugerir novamente
[REGRA] o que exatamente — porque motivo
Mínimo 3, idealmente 5–10. Inclua TODOS os [REJEITADO] reais — tudo que foi tentado e explicitamente recusado. NÃO invente rejeições. Se não houve nenhuma, omita [REJEITADO] completamente.

## ESTADO
Últimas 3–5 ações · o que funciona / o que está quebrado / o que está em andamento · próximo passo.

## BLOQUEIOS IMPLÍCITOS
O que você parou de sugerir nesta sessão porque o usuário rejeitou silenciosamente? (feedback negativo implícito — a coisa mais valiosa perdida em uma transferência)

## INSTRUÇÕES PARA O NOVO MODELO
3–5 regras: «Se [X] → [Y]» ou «Sempre/Nunca [Z] — porque [razão]».

⚠️ Se o contexto for parcialmente perdido — use a Transferência Completa para correção manual.`;
    // default: ru
    return `ПРОТОКОЛ SessionPort — ПРОСТОЙ ПЕРЕНОС.

Сначала ответь на один вопрос: что из нашей текущей переписки будет ПОТЕРЯНО при переносе? Для каждого пункта: критично / допустимо / неважно. В слепок войдёт только критичное.

Затем выведи строго по секциям:

## DNA ПРОЕКТА
- Домен, стек, цель — одно предложение-инструкция (глагол + задача + приоритет)
- Язык и стиль общения пользователя (лаконичный/многословный, рус/англ)
- Глобальные ограничения (технологии, запреты, дедлайны)

## РЕШЕНИЯ
Каждый пункт отдельной строкой. Причина и контекст обязательны:
[ПРИНЯТО] что именно — потому что причина — при каких обстоятельствах
[ОТКЛОНЕНО] что именно — потому что причина — почему никогда не предлагать снова
[ПРАВИЛО] что именно — потому что причина
Минимум 3, лучше 5–10. Включи ВСЕ реальные [ОТКЛОНЕНО] — всё что пробовали и явно отвергли. НЕ придумывай отклонения. Если их не было — пропусти [ОТКЛОНЕНО] полностью.

## СОСТОЯНИЕ
Последние 3–5 действий · что работает / что сломано / что в процессе · следующий шаг.

## НЕЯВНЫЕ ЗАПРЕТЫ
Что ты перестал предлагать в этой сессии потому что пользователь молча не принимал? (implicit negative feedback — самое ценное что теряется при переносе)

## ИНСТРУКЦИИ ДЛЯ НОВОЙ МОДЕЛИ
3–5 правил: «Если [X] → [Y]» или «Всегда/Никогда [Z] — потому что [причина]».

⚠️ Если контекст частично потерян — используй Расширенный перенос для ручной корректировки.`;
  },

  // Step 2 (Simple): generate v1.1 JSON with decisions[{what,why,type}] + instructions[] + validation{expected}.
  SIMPLE_CONFIRM: (transfer_id, parent_transfer_id) => {
    const L = _lang();
    const _json_en = `{"meta":{"protocol":"SessionPort","transfer_id":"${transfer_id}","project":"…","version":"1.1","date":"YYYY-MM-DD"${parent_transfer_id ? `,"parent_transfer_id":"${parent_transfer_id}"` : ''}},"dna":{"goal":"continuation instruction (verb+task+priority)","language":"en","style":"…","constraints":["…"],"trajectory":"where the project is heading — next major step or goal"},"decisions":[{"what":"…","why":"reason","context":"under what circumstances","type":"accepted"},{"what":"…","why":"reason","context":"what was tried and refused","type":"rejected"},{"what":"…","why":"reason","context":"","type":"rule"}],"state":{"current_task":"…","last_actions":["…","…","…"],"next_step":"…","artifacts":["file/function/concept"]},"instructions":["If X → Y","Always Z when W","Never Q — because R"],"open_threads":["genuinely unresolved question or branch we left open — why it matters"],"validation":{"questions":["?","?","?"],"expected":["criterion 1","criterion 2","criterion 3"]}}`;
    const _json_ru = `{"meta":{"protocol":"SessionPort","transfer_id":"${transfer_id}","project":"…","version":"1.1","date":"YYYY-MM-DD"${parent_transfer_id ? `,"parent_transfer_id":"${parent_transfer_id}"` : ''}},"dna":{"goal":"инструкция-продолжение (глагол+задача+приоритет)","language":"ru","style":"…","constraints":["…"],"trajectory":"куда движется проект — следующий крупный шаг или цель"},"decisions":[{"what":"…","why":"причина","context":"при каких обстоятельствах","type":"accepted"},{"what":"…","why":"причина","context":"что пробовали и явно отвергли","type":"rejected"},{"what":"…","why":"причина","context":"","type":"rule"}],"state":{"current_task":"…","last_actions":["…","…","…"],"next_step":"…","artifacts":["файл/функция/концепт"]},"instructions":["Если X → Y","Всегда Z при W","Никогда Q — потому что R"],"open_threads":["реально нерешённый вопрос или ветка, которую оставили открытой — почему это важно"],"validation":{"questions":["?","?","?"],"expected":["критерий 1","критерий 2","критерий 3"]}}`;
    const _tid = `meta.transfer_id = "${transfer_id}" character-for-character.${parent_transfer_id ? `\nmeta.parent_transfer_id = "${parent_transfer_id}" character-for-character.` : ''}`;
    const _tid_ru = `meta.transfer_id = "${transfer_id}" символ-в-символ.${parent_transfer_id ? `\nmeta.parent_transfer_id = "${parent_transfer_id}" символ-в-символ.` : ''}`;

    if (L === 'en') return `SessionPort PROTOCOL — SNAPSHOT GENERATION.

Convert the structured breakdown you produced in the previous step into a JSON snapshot — one-to-one, do NOT re-analyze the conversation from scratch or add items the user has not already seen. Fill in real data from our dialogue instead of "…". The transfer_id below is a unique label — do NOT look it up anywhere, just copy it into meta.transfer_id as-is:

\`\`\`json
${_json_en}
\`\`\`

or ---BEGIN CONTEXT---{…}---END CONTEXT---

CRITICAL: All data comes from our conversation above — no external sources needed.
decisions — minimum 3. Include ALL real type:"rejected" entries (what was tried and explicitly refused). Do NOT invent rejections — if there were none, the array may be empty. Each must have a non-empty "why".
validation.questions — make them probe real decisions and rejected items, so a wrong or partial restore yields a visibly wrong answer; do NOT ask trivia that can be copied straight from dna.goal.
${_tid}
First character {. Last character }. JSON only, no explanation.`;

    const _intro_ru = `ПРОТОКОЛ SessionPort — ГЕНЕРАЦИЯ СЛЕПКА.

Преобразуй структурный разбор, который ты выдал на предыдущем шаге, в JSON-слепок — один-в-один, не анализируй переписку заново и не добавляй пункты, которых пользователь ещё не видел. Подставь реальные данные из нашего диалога вместо «…». transfer_id ниже — уникальная метка, не ищи её нигде — просто скопируй в meta.transfer_id как есть:

\`\`\`json
${_json_ru}
\`\`\`

или ---BEGIN CONTEXT---{…}---END CONTEXT---`;
    const _crit_ru = `КРИТИЧНО: Все данные — из нашей переписки выше.
decisions — минимум 3. Включи ВСЕ реальные type:"rejected" (что пробовали и явно отвергли). НЕ выдумывай отклонения — если их не было, массив может быть пустым. Каждое с непустым "why".
validation.questions — формулируй так, чтобы они проверяли реальные решения и отклонённые варианты: при неверном или неполном восстановлении ответ будет заметно ошибочным. Не спрашивай то, что тривиально копируется из dna.goal.
${_tid_ru}
Первый символ {. Последний }. Только JSON, без пояснений.`;

    if (L === 'de') return `SessionPort PROTOKOLL — SNAPSHOT-GENERIERUNG.

Wandle die strukturierte Aufschlüsselung aus dem vorherigen Schritt eins-zu-eins in einen JSON-Snapshot um — analysiere das Gespräch nicht neu und füge keine Punkte hinzu, die der Nutzer noch nicht gesehen hat. Ersetze "…" durch echte Daten aus unserem Dialog. Die transfer_id ist eine eindeutige Kennung — suche sie nicht, kopiere sie einfach als meta.transfer_id:

\`\`\`json
${_json_en.replace('"language":"en"','"language":"de"').replace('"goal":"continuation instruction (verb+task+priority)"','"goal":"Fortsetzungs-Instruktion (Verb+Aufgabe+Priorität)"')}
\`\`\`

oder ---BEGIN CONTEXT---{…}---END CONTEXT---

KRITISCH: Alle Daten kommen aus unserem Gespräch oben.
decisions — mindestens 3. Erfasse ALLE realen type:"rejected" (was versucht und ausdrücklich abgelehnt wurde). Erfinde KEINE Ablehnungen — gab es keine, darf das Array leer sein. Jedes mit nicht leerem "why".
validation.questions — so formulieren, dass sie echte Entscheidungen und abgelehnte Punkte prüfen: bei falscher oder unvollständiger Wiederherstellung wird die Antwort sichtbar falsch. Frage nichts ab, was sich direkt aus dna.goal kopieren lässt.
${_tid}
Erstes Zeichen {. Letztes Zeichen }. Nur JSON, keine Erklärung.`;

    if (L === 'fr') return `PROTOCOLE SessionPort — GÉNÉRATION DU SNAPSHOT.

Convertis la décomposition structurée que tu as produite à l'étape précédente en snapshot JSON — un pour un, ne ré-analyse pas la conversation et n'ajoute pas d'éléments que l'utilisateur n'a pas déjà vus. Remplace "…" par des données réelles de notre dialogue. Le transfer_id est un label unique — ne le cherche pas, copie-le simplement dans meta.transfer_id tel quel :

\`\`\`json
${_json_en.replace('"language":"en"','"language":"fr"').replace('"goal":"continuation instruction (verb+task+priority)"','"goal":"instruction de continuation (verbe+tâche+priorité)"')}
\`\`\`

ou ---BEGIN CONTEXT---{…}---END CONTEXT---

CRITIQUE : Toutes les données viennent de notre conversation ci-dessus.
decisions — minimum 3. Inclus TOUS les type:"rejected" réels (ce qui a été essayé et explicitement refusé). N'invente PAS de rejets — s'il n'y en a eu aucun, le tableau peut être vide. Chacun avec un "why" non vide.
validation.questions — formule-les pour qu'elles testent de vraies décisions et des éléments rejetés : une restauration erronée ou partielle donnera une réponse visiblement fausse. Ne demande rien qui se copie directement depuis dna.goal.
${_tid}
Premier caractère {. Dernier caractère }. JSON uniquement, sans explication.`;

    if (L === 'es') return `PROTOCOLO SessionPort — GENERACIÓN DEL SNAPSHOT.

Convierte el desglose estructurado que produjiste en el paso anterior en un snapshot JSON — uno a uno, no vuelvas a analizar la conversación ni añadas elementos que el usuario no haya visto ya. Reemplaza "…" con datos reales de nuestro diálogo. El transfer_id es una etiqueta única — no lo busques, simplemente cópialo en meta.transfer_id tal cual:

\`\`\`json
${_json_en.replace('"language":"en"','"language":"es"').replace('"goal":"continuation instruction (verb+task+priority)"','"goal":"instrucción de continuación (verbo+tarea+prioridad)"')}
\`\`\`

o ---BEGIN CONTEXT---{…}---END CONTEXT---

CRÍTICO: Todos los datos provienen de nuestra conversación anterior.
decisions — mínimo 3. Incluye TODOS los type:"rejected" reales (lo que se intentó y fue rechazado explícitamente). NO inventes rechazos — si no hubo ninguno, el arreglo puede quedar vacío. Cada uno con un "why" no vacío.
validation.questions — formúlalas para que pongan a prueba decisiones reales y elementos rechazados: una restauración errónea o parcial dará una respuesta visiblemente incorrecta. No preguntes nada que se copie directamente de dna.goal.
${_tid}
Primer carácter {. Último carácter }. Solo JSON, sin explicación.`;

    if (L === 'zh') return `SessionPort 协议 — 快照生成。

将你在上一步生成的结构化分解一对一转换为JSON快照——不要重新分析对话，也不要添加用户尚未看到的条目。将"…"替换为对话中的真实数据。transfer_id是唯一标识符——不要查找它，直接复制到meta.transfer_id中：

\`\`\`json
${_json_en.replace('"language":"en"','"language":"zh"').replace('"goal":"continuation instruction (verb+task+priority)"','"goal":"继续指令（动词+任务+优先级）"')}
\`\`\`

或 ---BEGIN CONTEXT---{…}---END CONTEXT---

关键：所有数据来自上面的对话——不需要外部来源。
decisions — 最少3条。包含所有真实的type:"rejected"（什么被尝试并被明确拒绝）。不要编造拒绝——如果没有，数组可以为空。每条必须有非空的"why"。
validation.questions — 设计成检验真实决策和被拒绝项：当恢复错误或不完整时答案会明显出错。不要问可以直接从dna.goal复制的内容。
${_tid}
第一个字符{。最后一个字符}。仅JSON，无说明。`;

    if (L === 'ja') return `SessionPort プロトコル — スナップショット生成。

前のステップで作成した構造化された分解を一対一でJSONスナップショットに変換してください — 会話を再分析したり、ユーザーがまだ見ていない項目を追加したりしないでください。「…」を対話からの実際のデータに置き換えてください。transfer_idは一意のラベルです — 検索せず、meta.transfer_idにそのままコピーしてください：

\`\`\`json
${_json_en.replace('"language":"en"','"language":"ja"').replace('"goal":"continuation instruction (verb+task+priority)"','"goal":"継続指示（動詞+タスク+優先度）"')}
\`\`\`

または ---BEGIN CONTEXT---{…}---END CONTEXT---

重要：すべてのデータは上の会話から来ています。
decisions — 最低3つ。実際のtype:"rejected"をすべて含めてください（試みられ明示的に拒否されたもの）。拒否を作り上げないでください — なかった場合は配列が空でも構いません。各々に空でない"why"が必要です。
validation.questions — 実際の決定と拒否された項目を検証するように作ってください：復元が誤っている、または不完全な場合に答えが明らかに間違って出るように。dna.goalからそのままコピーできるようなことは尋ねないでください。
${_tid}
最初の文字{。最後の文字}。JSONのみ、説明なし。`;

    if (L === 'ko') return `SessionPort 프로토콜 — 스냅샷 생성.

이전 단계에서 작성한 구조화된 분석을 일대일로 JSON 스냅샷으로 변환하세요 — 대화를 다시 분석하거나 사용자가 아직 보지 못한 항목을 추가하지 마세요. "…"를 대화의 실제 데이터로 교체하세요. transfer_id는 고유 레이블입니다 — 검색하지 말고 meta.transfer_id에 그대로 복사하세요:

\`\`\`json
${_json_en.replace('"language":"en"','"language":"ko"').replace('"goal":"continuation instruction (verb+task+priority)"','"goal":"계속 지시 (동사+작업+우선순위)"')}
\`\`\`

또는 ---BEGIN CONTEXT---{…}---END CONTEXT---

중요: 모든 데이터는 위의 대화에서 가져옵니다.
decisions — 최소 3개. 실제 type:"rejected"를 모두 포함하세요 (시도되었고 명시적으로 거부된 것). 거부를 지어내지 마세요 — 없었다면 배열이 비어 있어도 됩니다. 각각 비어 있지 않은 "why"가 필요합니다.
validation.questions — 실제 결정과 거부된 항목을 검증하도록 만드세요: 복원이 틀리거나 불완전하면 답이 눈에 띄게 잘못 나오도록. dna.goal에서 그대로 복사할 수 있는 것은 묻지 마세요.
${_tid}
첫 번째 문자 {. 마지막 문자 }. JSON만, 설명 없음.`;

    if (L === 'pt') return `PROTOCOLO SessionPort — GERAÇÃO DO SNAPSHOT.

Converta a decomposição estruturada que você produziu na etapa anterior em um snapshot JSON — um para um, não reanalise a conversa nem adicione itens que o usuário ainda não viu. Substitua "…" por dados reais do nosso diálogo. O transfer_id é um rótulo único — não o procure, apenas copie-o para meta.transfer_id como está:

\`\`\`json
${_json_en.replace('"language":"en"','"language":"pt"').replace('"goal":"continuation instruction (verb+task+priority)"','"goal":"instrução de continuação (verbo+tarefa+prioridade)"')}
\`\`\`

ou ---BEGIN CONTEXT---{…}---END CONTEXT---

CRÍTICO: Todos os dados vêm da nossa conversa acima.
decisions — mínimo 3. Inclua TODOS os type:"rejected" reais (o que foi tentado e explicitamente recusado). NÃO invente rejeições — se não houve nenhuma, o array pode ficar vazio. Cada um com um "why" não vazio.
validation.questions — formule-as para testar decisões reais e itens rejeitados: uma restauração errada ou parcial dará uma resposta visivelmente incorreta. Não pergunte nada que se copie diretamente de dna.goal.
${_tid}
Primeiro caractere {. Último caractere }. Apenas JSON, sem explicação.`;

    // default: ru
    return `${_intro_ru}

${_crit_ru}`;
  },

  // Step 1 (Extended): interactive extraction + implicit patterns.
  EXTENDED_PREPARE: (transfer_id) => {
    const L = _lang();
    if (L === 'en') return `SessionPort PROTOCOL — TRANSFER PREPARATION.

Analyze our current conversation in this chat. Ask clarifying questions by category (one at a time):

DECISIONS: Which decisions in our dialogue cannot be reconsidered? Why exactly?
REJECTIONS: What was tried and discarded? Why exactly — so the new model never suggests it again?
RULES: What working rules and constraints emerged from our conversation?
STATE: Where did we stop? What is the next step? Specific files/functions?
PATTERNS: How did your response style change over the session? What did you stop suggesting and why?

No limit on iterations. After I say "ready" — we move to anchor verification.`;
    if (L === 'de') return `SessionPort PROTOKOLL — TRANSFER-VORBEREITUNG.

Analysiere unser aktuelles Gespräch in diesem Chat. Stelle Klärungsfragen nach Kategorie (eine nach der anderen):

ENTSCHEIDUNGEN: Welche Entscheidungen in unserem Dialog können nicht rückgängig gemacht werden? Warum genau?
ABLEHNUNGEN: Was wurde versucht und verworfen? Warum genau — damit das neue Modell es nie wieder vorschlägt?
REGELN: Welche Arbeitsregeln und Einschränkungen sind aus unserem Gespräch entstanden?
ZUSTAND: Wo haben wir aufgehört? Was ist der nächste Schritt? Konkrete Dateien/Funktionen?
MUSTER: Wie hat sich dein Antwortstil im Laufe der Sitzung verändert? Was hast du aufgehört vorzuschlagen und warum?

Keine Begrenzung der Iterationen. Nachdem ich „fertig" sage — gehen wir zur Ankerverifizierung über.`;
    if (L === 'fr') return `PROTOCOLE SessionPort — PRÉPARATION AU TRANSFERT.

Analyse notre conversation actuelle dans ce chat. Pose des questions de clarification par catégorie (une à la fois) :

DÉCISIONS : Quelles décisions dans notre dialogue ne peuvent pas être reconsidérées ? Pourquoi exactement ?
REJETS : Qu'est-ce qui a été essayé et rejeté ? Pourquoi exactement — pour que le nouveau modèle ne le suggère jamais à nouveau ?
RÈGLES : Quelles règles de travail et contraintes ont émergé de notre conversation ?
ÉTAT : Où nous sommes-nous arrêtés ? Quelle est la prochaine étape ? Fichiers/fonctions spécifiques ?
MODÈLES : Comment ton style de réponse a-t-il évolué au cours de la session ? Qu'as-tu arrêté de suggérer et pourquoi ?

Pas de limite d'itérations. Après que je dise « prêt » — on passe à la vérification des ancres.`;
    if (L === 'es') return `PROTOCOLO SessionPort — PREPARACIÓN PARA TRANSFERENCIA.

Analiza nuestra conversación actual en este chat. Haz preguntas de aclaración por categoría (una a la vez):

DECISIONES: ¿Qué decisiones en nuestro diálogo no pueden reconsiderarse? ¿Por qué exactamente?
RECHAZOS: ¿Qué se intentó y se descartó? ¿Por qué exactamente — para que el nuevo modelo nunca lo sugiera de nuevo?
REGLAS: ¿Qué reglas de trabajo y restricciones surgieron de nuestra conversación?
ESTADO: ¿Dónde nos detuvimos? ¿Cuál es el siguiente paso? ¿Archivos/funciones específicos?
PATRONES: ¿Cómo cambió tu estilo de respuesta durante la sesión? ¿Qué dejaste de sugerir y por qué?

Sin límite de iteraciones. Después de que diga "listo" — pasamos a la verificación de anclas.`;
    if (L === 'zh') return `SessionPort 协议 — 传输准备。

分析我们在此聊天中的当前对话。按类别逐一提出澄清问题：

决策：我们对话中哪些决定不可重新考虑？确切原因是什么？
拒绝：什么被尝试过并被丢弃？确切原因是什么——以便新模型永远不再建议？
规则：我们的对话中产生了哪些工作规则和约束？
状态：我们在哪里停下来了？下一步是什么？具体的文件/函数？
模式：你在整个会话中的回复风格如何变化？你停止建议了什么，为什么？

迭代次数不限。当我说"准备好了"后——进入锚点验证。`;
    if (L === 'ja') return `SessionPort プロトコル — 転送準備。

このチャットでの現在の会話を分析してください。カテゴリ別に確認の質問をしてください（一度に1つ）：

決定事項：私たちの対話でどの決定を再考できませんか？なぜですか？
却下：何を試みて廃棄しましたか？なぜ正確に — 新しいモデルが再提案しないように？
ルール：会話の中でどのような作業ルールと制約が生まれましたか？
状態：どこで止まりましたか？次のステップは何ですか？具体的なファイル/関数は？
パターン：セッションを通じてあなたの返答スタイルはどのように変わりましたか？何を提案するのをやめましたか、なぜ？

繰り返し回数に制限はありません。私が「準備完了」と言ったら — アンカー検証に進みます。`;
    if (L === 'ko') return `SessionPort 프로토콜 — 전송 준비.

이 채팅에서 현재 대화를 분석하세요. 카테고리별로 명확화 질문을 하세요 (한 번에 하나씩):

결정: 우리 대화에서 어떤 결정을 재고할 수 없습니까? 왜 정확히?
거부: 무엇을 시도했다가 폐기했습니까? 정확히 왜 — 새 모델이 다시 제안하지 않도록?
규칙: 우리 대화에서 어떤 작업 규칙과 제약이 생겼습니까?
상태: 어디서 멈췄습니까? 다음 단계는 무엇입니까? 구체적인 파일/함수?
패턴: 세션 동안 답변 스타일이 어떻게 변했습니까? 제안을 중단한 것은 무엇이고 왜?

반복 횟수 제한 없음. 내가 "준비됐어"라고 하면 — 앵커 검증으로 넘어갑니다.`;
    if (L === 'pt') return `PROTOCOLO SessionPort — PREPARAÇÃO PARA TRANSFERÊNCIA.

Analise nossa conversa atual neste chat. Faça perguntas de esclarecimento por categoria (uma de cada vez):

DECISÕES: Quais decisões em nosso diálogo não podem ser reconsideradas? Por que exatamente?
REJEIÇÕES: O que foi tentado e descartado? Por que exatamente — para que o novo modelo nunca sugira novamente?
REGRAS: Quais regras de trabalho e restrições surgiram de nossa conversa?
ESTADO: Onde paramos? Qual é o próximo passo? Arquivos/funções específicos?
PADRÕES: Como seu estilo de resposta mudou durante a sessão? O que você parou de sugerir e por quê?

Sem limite de iterações. Depois que eu dizer "pronto" — passamos para a verificação de âncoras.`;
    // default: ru
    return `ПРОТОКОЛ SessionPort — ПОДГОТОВКА К ПЕРЕНОСУ.

Проанализируй нашу переписку в этом чате. Задай уточняющие вопросы по категориям (по одной за раз):

РЕШЕНИЯ: Какие решения из нашего диалога нельзя пересматривать? Почему именно такие?
ОТКАЗЫ: Что пробовали и отвергли? Почему именно — чтобы новая модель никогда не предлагала снова?
ПРАВИЛА: Какие рабочие правила и ограничения возникли в ходе разговора?
СОСТОЯНИЕ: На чём остановились? Что следующий шаг? Конкретные файлы/функции?
ПАТТЕРНЫ: Как изменился твой стиль ответов за сессию? Что ты перестал предлагать и почему?

Количество итераций не ограничено. После моего «готово» — переходим к проверке якорей.`;
  },

  // Step 2 (Extended): 5-layer verification including implicit context.
  EXTENDED_ANCHORS: (transfer_id) => {
    const L = _lang();
    if (L === 'en') return `SessionPort PROTOCOL — ANCHOR VERIFICATION.

Based on everything discussed in this chat, output by layers:

## LAYER 1 — GOAL AND DNA
Continuation instruction · language · communication style · global constraints.

## LAYER 2 — DECISIONS
Each on its own line with reason and type:
[ACCEPTED] what · why · under what circumstances
[REJECTED] what · why · why never suggest again (all real ones; do not invent)
[RULE] what · why

## LAYER 3 — STATE
Last actions · artifacts (files/functions/concepts) · next step.

## LAYER 4 — INSTRUCTIONS
Behavioral rules: "If X → Y", "Always/Never Z — because reason".

## LAYER 5 — IMPLICIT
CALIBRATION: User expertise level (beginner/confident/expert/guru) — and what is your assessment based on?
PATTERNS: When did the user accept suggestions quickly — what do they have in common? When rejected — what do they share?
ADAPTATIONS: What did you stop suggesting and after which message? How did you adjust response length/tone?
ASSUMPTIONS: What do you assume about the project without explicit data? (each with confidence: high/medium/low)
BLIND SPOTS: Which specific questions, had you asked them, would have changed your earlier decisions?

I will review each layer and tell you what to change. If everything is fine — we proceed to generation.`;
    if (L === 'de') return `SessionPort PROTOKOLL — ANKERVERIFIZIERUNG.

Basierend auf allem, was in diesem Chat besprochen wurde, gib nach Schichten aus:

## SCHICHT 1 — ZIEL UND DNA
Fortsetzungs-Instruktion · Sprache · Kommunikationsstil · globale Einschränkungen.

## SCHICHT 2 — ENTSCHEIDUNGEN
Jede in einer eigenen Zeile mit Grund und Typ:
[ANGENOMMEN] was · warum · unter welchen Umständen
[ABGELEHNT] was · warum · warum nie wieder vorschlagen (alle realen; keine erfinden)
[REGEL] was · warum

## SCHICHT 3 — ZUSTAND
Letzte Aktionen · Artefakte (Dateien/Funktionen/Konzepte) · nächster Schritt.

## SCHICHT 4 — ANWEISUNGEN
Verhaltensregeln: „Wenn X → Y", „Immer/Nie Z — weil Grund".

## SCHICHT 5 — IMPLIZIT
KALIBRIERUNG: Expertise-Level des Nutzers (Anfänger/sicher/Experte/Guru) — und worauf basiert die Einschätzung?
MUSTER: Wann hat der Nutzer Vorschläge schnell angenommen — was haben diese gemeinsam? Wann abgelehnt — was gemeinsam?
ANPASSUNGEN: Was hast du aufgehört vorzuschlagen und nach welcher Nachricht? Wie hast du Länge/Ton der Antworten angepasst?
ANNAHMEN: Was nimmst du über das Projekt ohne explizite Daten an? (jede mit Konfidenz: high/medium/low)
BLINDE FLECKEN: Welche konkreten Fragen hätten, wenn du sie gestellt hättest, deine früheren Entscheidungen verändert?

Ich überprüfe jede Schicht und sage dir, was geändert werden soll. Wenn alles in Ordnung ist — gehen wir zur Generierung über.`;
    if (L === 'fr') return `PROTOCOLE SessionPort — VÉRIFICATION DES ANCRES.

Sur la base de tout ce qui a été discuté dans ce chat, donne par couches :

## COUCHE 1 — OBJECTIF ET ADN
Instruction de continuation · langue · style de communication · contraintes globales.

## COUCHE 2 — DÉCISIONS
Chacune sur sa propre ligne avec raison et type :
[ACCEPTÉ] quoi · pourquoi · dans quelles circonstances
[REJETÉ] quoi · pourquoi · pourquoi ne plus jamais suggérer (tous les réels ; n'en invente pas)
[RÈGLE] quoi · pourquoi

## COUCHE 3 — ÉTAT
Dernières actions · artefacts (fichiers/fonctions/concepts) · prochaine étape.

## COUCHE 4 — INSTRUCTIONS
Règles comportementales : « Si X → Y », « Toujours/Jamais Z — parce que raison ».

## COUCHE 5 — IMPLICITE
CALIBRATION : Niveau d'expertise de l'utilisateur (débutant/confiant/expert/guru) — sur quoi est basée votre évaluation ?
MODÈLES : Quand l'utilisateur a-t-il accepté les suggestions rapidement — qu'ont-elles en commun ? Quand rejeté — qu'ont-elles en commun ?
ADAPTATIONS : Qu'avez-vous arrêté de suggérer et après quel message ? Comment avez-vous ajusté la longueur/le ton des réponses ?
HYPOTHÈSES : Que supposez-vous sur le projet sans données explicites ? (chacune avec confiance : high/medium/low)
ANGLES MORTS : Quelles questions spécifiques, si vous les aviez posées, auraient changé vos décisions antérieures ?

Je vérifierai chaque couche et vous dirai quoi changer. Si tout est correct — nous procédons à la génération.`;
    if (L === 'es') return `PROTOCOLO SessionPort — VERIFICACIÓN DE ANCLAS.

Basándote en todo lo discutido en este chat, proporciona por capas:

## CAPA 1 — OBJETIVO Y ADN
Instrucción de continuación · idioma · estilo de comunicación · restricciones globales.

## CAPA 2 — DECISIONES
Cada una en su propia línea con razón y tipo:
[ACEPTADO] qué · por qué · en qué circunstancias
[RECHAZADO] qué · por qué · por qué nunca volver a sugerir (todos los reales; no inventes)
[REGLA] qué · por qué

## CAPA 3 — ESTADO
Últimas acciones · artefactos (archivos/funciones/conceptos) · siguiente paso.

## CAPA 4 — INSTRUCCIONES
Reglas de comportamiento: "Si X → Y", "Siempre/Nunca Z — porque razón".

## CAPA 5 — IMPLÍCITO
CALIBRACIÓN: Nivel de experiencia del usuario (principiante/seguro/experto/guru) — ¿en qué se basa su evaluación?
PATRONES: ¿Cuándo aceptó el usuario sugerencias rápidamente — qué tienen en común? ¿Cuándo rechazó — qué comparten?
ADAPTACIONES: ¿Qué dejaste de sugerir y después de qué mensaje? ¿Cómo ajustaste la longitud/tono de las respuestas?
SUPOSICIONES: ¿Qué asumes sobre el proyecto sin datos explícitos? (cada una con confianza: high/medium/low)
PUNTOS CIEGOS: ¿Qué preguntas específicas, si las hubieras hecho, habrían cambiado tus decisiones anteriores?

Revisaré cada capa y te diré qué cambiar. Si todo está bien — procedemos a la generación.`;
    if (L === 'zh') return `SessionPort 协议 — 锚点验证。

根据此聊天中讨论的所有内容，按层次输出：

## 第1层 — 目标与DNA
继续指令 · 语言 · 沟通风格 · 全局约束。

## 第2层 — 决策
每项单独一行，包含原因和类型：
[已采纳] 什么 · 为什么 · 在什么情况下
[已拒绝] 什么 · 为什么 · 为什么不再建议（所有真实的；不要编造）
[规则] 什么 · 为什么

## 第3层 — 状态
最近操作 · 工件（文件/函数/概念）· 下一步。

## 第4层 — 指令
行为规则：「如果X→Y」，「总是/永不Z——因为原因」。

## 第5层 — 隐性
校准：用户专业水平（初学者/自信/专家/大师）——评估基于什么？
模式：用户何时快速接受建议——有什么共同点？何时拒绝——有什么共同点？
适应：你停止建议了什么，在哪条消息之后？如何调整回复长度/语气？
假设：你对项目有什么没有明确数据的假设？（每条带置信度：high/medium/low）
盲点：如果你提出了哪些具体问题，会改变你之前的决定？

我将审查每一层并告诉你需要更改什么。如果一切正常——我们继续生成。`;
    if (L === 'ja') return `SessionPort プロトコル — アンカー検証。

このチャットで議論されたすべてに基づいて、レイヤーごとに出力してください：

## レイヤー1 — 目標とDNA
継続指示 · 言語 · コミュニケーションスタイル · グローバル制約。

## レイヤー2 — 決定事項
各々別の行に、理由とタイプを含めて：
[採用] 何 · なぜ · どのような状況で
[却下] 何 · なぜ · なぜ再提案しないか（実際のものすべて；作り上げない）
[ルール] 何 · なぜ

## レイヤー3 — 状態
最後のアクション · アーティファクト（ファイル/関数/概念）· 次のステップ。

## レイヤー4 — 指示
行動ルール：「もしX→Y」、「常に/決してZ — なぜなら理由」。

## レイヤー5 — 暗黙
キャリブレーション：ユーザーの専門知識レベル（初心者/自信がある/エキスパート/グル）— 評価の根拠は？
パターン：ユーザーがいつ提案を素早く受け入れたか — 共通点は？いつ拒否したか — 共通点は？
適応：何を提案するのをやめましたか、どのメッセージの後で？返答の長さ/トーンをどう調整しましたか？
仮定：明示的なデータなしにプロジェクトについて何を仮定していますか？（各々に信頼度：high/medium/low）
盲点：どの具体的な質問を尋ねていたら、以前の決定が変わっていましたか？

各レイヤーを確認して何を変更するかお伝えします。すべて問題なければ — 生成に進みます。`;
    if (L === 'ko') return `SessionPort 프로토콜 — 앵커 검증.

이 채팅에서 논의된 모든 것을 바탕으로 레이어별로 출력하세요:

## 레이어 1 — 목표와 DNA
계속 지시 · 언어 · 소통 스타일 · 전역 제약.

## 레이어 2 — 결정 사항
각각 별도의 줄에, 이유와 유형 포함:
[채택] 무엇 · 왜 · 어떤 상황에서
[거부] 무엇 · 왜 · 왜 다시 제안하지 않는가 (실제 항목만; 만들어내지 말것)
[규칙] 무엇 · 왜

## 레이어 3 — 상태
마지막 작업 · 아티팩트 (파일/함수/개념) · 다음 단계.

## 레이어 4 — 지시
행동 규칙: "만약 X → Y", "항상/절대로 Z — 왜냐하면 이유".

## 레이어 5 — 암묵적
캘리브레이션: 사용자 전문성 수준 (초보자/자신감/전문가/구루) — 평가 근거는?
패턴: 사용자가 제안을 빨리 수락했을 때 — 공통점은? 거부했을 때 — 공통점은?
적응: 무엇을 제안하는 것을 중단했고 어떤 메시지 이후에? 답변 길이/톤을 어떻게 조정했나?
가정: 명시적 데이터 없이 프로젝트에 대해 무엇을 가정합니까? (각각 신뢰도: high/medium/low)
맹점: 어떤 구체적인 질문을 했더라면 이전 결정이 바뀌었을 것입니까?

각 레이어를 검토하고 무엇을 변경할지 알려드리겠습니다. 모든 것이 괜찮으면 — 생성으로 진행합니다.`;
    if (L === 'pt') return `PROTOCOLO SessionPort — VERIFICAÇÃO DE ÂNCORAS.

Com base em tudo discutido neste chat, apresente por camadas:

## CAMADA 1 — OBJETIVO E DNA
Instrução de continuação · idioma · estilo de comunicação · restrições globais.

## CAMADA 2 — DECISÕES
Cada uma em sua própria linha com motivo e tipo:
[ACEITO] o quê · por quê · em que circunstâncias
[REJEITADO] o quê · por quê · por que nunca sugerir novamente (todos os reais; não invente)
[REGRA] o quê · por quê

## CAMADA 3 — ESTADO
Últimas ações · artefatos (arquivos/funções/conceitos) · próximo passo.

## CAMADA 4 — INSTRUÇÕES
Regras comportamentais: "Se X → Y", "Sempre/Nunca Z — porque razão".

## CAMADA 5 — IMPLÍCITO
CALIBRAÇÃO: Nível de expertise do usuário (iniciante/confiante/especialista/guru) — em que se baseia sua avaliação?
PADRÕES: Quando o usuário aceitou sugestões rapidamente — o que têm em comum? Quando rejeitou — o que têm em comum?
ADAPTAÇÕES: O que você parou de sugerir e após qual mensagem? Como ajustou o comprimento/tom das respostas?
SUPOSIÇÕES: O que você supõe sobre o projeto sem dados explícitos? (cada uma com confiança: high/medium/low)
PONTOS CEGOS: Quais perguntas específicas, se tivesse feito, teriam mudado suas decisões anteriores?

Vou revisar cada camada e dizer o que mudar. Se tudo estiver correto — prosseguimos para a geração.`;
    // default: ru
    return `ПРОТОКОЛ SessionPort — ПРОВЕРКА ЯКОРЕЙ.

На основе всего обсуждения в этом чате выведи по слоям:

## СЛОЙ 1 — ЦЕЛЬ И ДНК
Инструкция-продолжение · язык · стиль общения · глобальные ограничения.

## СЛОЙ 2 — РЕШЕНИЯ
Каждое отдельной строкой с причиной и типом:
[ПРИНЯТО] что · почему · при каких обстоятельствах
[ОТКЛОНЕНО] что · почему · почему никогда не предлагать снова (все реальные; не придумывать)
[ПРАВИЛО] что · почему

## СЛОЙ 3 — СОСТОЯНИЕ
Последние действия · артефакты (файлы/функции/концепты) · следующий шаг.

## СЛОЙ 4 — ИНСТРУКЦИИ
Поведенческие правила: «Если X → Y», «Всегда/Никогда Z — потому что причина».

## СЛОЙ 5 — НЕЯВНОЕ
КАЛИБРОВКА: Уровень экспертизы пользователя (новичок/уверенный/эксперт/гуру) — и на чём основана оценка?
ПАТТЕРНЫ: Когда пользователь принимал предложения быстро — что у них общего? Когда отклонял — что общего?
АДАПТАЦИИ: Что ты перестал предлагать и после какого сообщения? Как изменил длину/тон ответов?
ПРЕДПОЛОЖЕНИЯ: Что предполагаешь о проекте без явных данных? (каждое с уровнем уверенности high/medium/low)
СЛЕПЫЕ ПЯТНА: Какие конкретные вопросы, если бы ты их задал, изменили бы твои предыдущие решения?

Я проверю каждый слой и скажу что изменить. Если всё ок — переходим к генерации.`;
  },

  // Step 3 (Extended): full v1.1 JSON with implicit section.
  EXTENDED_TRANSFER: (transfer_id, parent_transfer_id) => {
    const L = _lang();
    const _ptid = parent_transfer_id ? `,"parent_transfer_id":"${parent_transfer_id}"` : '';
    const _json_en = `{"meta":{"protocol":"SessionPort","transfer_id":"${transfer_id}","project":"…","version":"1.1","date":"YYYY-MM-DD"${_ptid}},"dna":{"goal":"continuation instruction","language":"en","style":"…","constraints":["…"],"trajectory":"next major step/goal of the project"},"decisions":[{"what":"…","why":"reason — what was tried and explicitly refused","type":"rejected"},{"what":"…","why":"reason","type":"rule"},{"what":"…","why":"reason","type":"accepted"}],"state":{"current_task":"…","last_actions":["…","…","…"],"next_step":"…","artifacts":["…"]},"instructions":["If X → Y","Always Z when W","Never Q — because R"],"open_threads":["genuinely unresolved question or branch we left open — why it matters"],"implicit":{"user_profile":{"expertise":"expert/confident/beginner","style":"…","priorities":["…"],"profile_confidence":"high/medium/low — based on N messages"},"adaptation_log":["Stopped suggesting X after message N — user never accepted it","Reduced detail level — user replied briefly"],"blind_spots":["Which question, had I asked it, would have changed my decision about X?"],"assumptions":[{"what":"…","confidence":"high/medium/low"}]},"validation":{"questions":["?","?","?"],"expected":["criterion 1","criterion 2","criterion 3"]}}`;
    const _json_ru = `{"meta":{"protocol":"SessionPort","transfer_id":"${transfer_id}","project":"…","version":"1.1","date":"YYYY-MM-DD"${_ptid}},"dna":{"goal":"инструкция-продолжение","language":"ru","style":"…","constraints":["…"],"trajectory":"следующий крупный шаг/цель проекта"},"decisions":[{"what":"…","why":"причина — что пробовали и явно отвергли","type":"rejected"},{"what":"…","why":"причина","type":"rule"},{"what":"…","why":"причина","type":"accepted"}],"state":{"current_task":"…","last_actions":["…","…","…"],"next_step":"…","artifacts":["…"]},"instructions":["Если X → Y","Всегда Z при W","Никогда Q — потому что R"],"open_threads":["реально нерешённый вопрос или ветка, которую оставили открытой — почему это важно"],"implicit":{"user_profile":{"expertise":"эксперт/уверенный/новичок","style":"…","priorities":["…"],"profile_confidence":"high/medium/low — основано на N сообщениях"},"adaptation_log":["Перестал предлагать X после сообщения N — пользователь ни разу не принял","Сократил детальность — пользователь отвечал коротко"],"blind_spots":["Какой вопрос, если бы я его задал, изменил бы моё решение по X?"],"assumptions":[{"what":"…","confidence":"high/medium/low"}]},"validation":{"questions":["?","?","?"],"expected":["критерий 1","критерий 2","критерий 3"]}}`;
    const _tid_en = `meta.transfer_id = "${transfer_id}" character-for-character.${parent_transfer_id ? `\nmeta.parent_transfer_id = "${parent_transfer_id}" character-for-character.` : ''}`;
    const _tid_ru = `meta.transfer_id = "${transfer_id}" символ-в-символ.${parent_transfer_id ? `\nmeta.parent_transfer_id = "${parent_transfer_id}" символ-в-символ.` : ''}`;

    const _wrap_en = (intro) => `${intro}

\`\`\`json
${_json_en}
\`\`\`

or ---BEGIN CONTEXT---{…}---END CONTEXT---

CRITICAL: decisions — include ALL real type:"rejected" (what was tried and explicitly refused). Do NOT invent rejections — if there were none, the array may be empty. Each with non-empty "why". implicit.adaptation_log — real behavior changes only.
validation.questions — make them probe real decisions and rejected items, so a wrong or partial restore yields a visibly wrong answer; do NOT ask trivia copyable straight from dna.goal.
${_tid_en}
First character {. Last character }. JSON only.`;

    if (L === 'en') return _wrap_en(`SessionPort PROTOCOL — SNAPSHOT GENERATION.

Based on the anchors (layers 1–4) and implicit context (layer 5) verified above, generate JSON. The transfer_id below is a unique label — do NOT look it up anywhere, just copy it into meta.transfer_id as-is:`);

    if (L === 'de') return _wrap_en(`SessionPort PROTOKOLL — SNAPSHOT-GENERIERUNG.

Generiere basierend auf den verifizierten Ankern (Schichten 1–4) und implizitem Kontext (Schicht 5) JSON. Die transfer_id ist eine eindeutige Kennung — kopiere sie einfach als meta.transfer_id:`);

    if (L === 'fr') return _wrap_en(`PROTOCOLE SessionPort — GÉNÉRATION DU SNAPSHOT.

Sur la base des ancres vérifiées (couches 1–4) et du contexte implicite (couche 5), génère le JSON. Le transfer_id est un label unique — copie-le simplement dans meta.transfer_id tel quel :`);

    if (L === 'es') return _wrap_en(`PROTOCOLO SessionPort — GENERACIÓN DEL SNAPSHOT.

Basándote en las anclas verificadas (capas 1–4) y el contexto implícito (capa 5), genera JSON. El transfer_id es una etiqueta única — simplemente cópialo en meta.transfer_id tal cual:`);

    if (L === 'zh') return _wrap_en(`SessionPort 协议 — 快照生成。

根据上面验证的锚点（第1–4层）和隐性上下文（第5层），生成JSON。transfer_id是唯一标识符——直接复制到meta.transfer_id中：`);

    if (L === 'ja') return _wrap_en(`SessionPort プロトコル — スナップショット生成。

上で検証されたアンカー（レイヤー1–4）と暗黙のコンテキスト（レイヤー5）に基づいてJSONを生成してください。transfer_idは一意のラベルです — meta.transfer_idにそのままコピーしてください：`);

    if (L === 'ko') return _wrap_en(`SessionPort 프로토콜 — 스냅샷 생성.

위에서 검증된 앵커(레이어 1–4)와 암묵적 컨텍스트(레이어 5)를 바탕으로 JSON을 생성하세요. transfer_id는 고유 레이블입니다 — meta.transfer_id에 그대로 복사하세요:`);

    if (L === 'pt') return _wrap_en(`PROTOCOLO SessionPort — GERAÇÃO DO SNAPSHOT.

Com base nas âncoras verificadas (camadas 1–4) e no contexto implícito (camada 5), gere JSON. O transfer_id é um rótulo único — copie-o simplesmente para meta.transfer_id como está:`);

    // default: ru
    return `ПРОТОКОЛ SessionPort — ГЕНЕРАЦИЯ СЛЕПКА.

На основе якорей (слои 1–4) и неявного контекста (слой 5), верифицированных выше, сформируй JSON. transfer_id — уникальная метка, не ищи её нигде — просто скопируй в meta.transfer_id как есть:

\`\`\`json
${_json_ru}
\`\`\`

или ---BEGIN CONTEXT---{…}---END CONTEXT---

КРИТИЧНО: decisions — включи ВСЕ реальные type:"rejected" (что пробовали и явно отвергли). НЕ выдумывай отклонения — если их не было, массив может быть пустым. Каждое с непустым "why". implicit.adaptation_log — только реальные изменения поведения.
validation.questions — формулируй так, чтобы они проверяли реальные решения и отклонённые варианты: при неверном или неполном восстановлении ответ будет заметно ошибочным. Не спрашивай то, что тривиально копируется из dna.goal.
${_tid_ru}
Первый символ {. Последний }. Только JSON.`;
  }
};

// ═══════════════════════════════════════════════════════════
// ROUTER — showScreen
// ═══════════════════════════════════════════════════════════
const SCREENS = ['screenMain', 'screenHistory', 'screenDonate', 'screenBug', 'screenMap', 'screenTrash', 'screenSettings', 'screenPrompts', 'screenPromptEdit', 'screenPromptTrash'];

const PERSISTENT_SCREENS = ['main', 'prompts'];

function showScreen(name) {
  const key = 'screen' + name.charAt(0).toUpperCase() + name.slice(1);
  SCREENS.forEach(id => document.getElementById(id)?.classList.remove('visible'));
  document.getElementById(key)?.classList.add('visible');
  if (name === 'history')      renderHistoryScreen();
  if (name === 'map')          _initMapScreen();
  if (name === 'trash')        renderTrashScreen();
  if (name === 'settings')     initSettingsScreen();
  if (name === 'prompts')      initPromptsScreen();
  if (name === 'promptEdit')   initPromptEditScreen();
  if (name === 'promptTrash')  initPromptTrashScreen();
  if (PERSISTENT_SCREENS.includes(name)) {
    chrome.storage.local.set({ last_screen: name });
  }
  // Toggle header Prompts button: shows current context & navigates in reverse
  _updatePromptsBtn(name);
}

// Updates the persistent header Prompts button depending on which screen is active.
// On main/transfer: shows "Prompts" → navigates to prompts screen.
// On prompts/promptEdit/promptTrash: shows "← Back" → navigates back to main.
function _updatePromptsBtn(screenName) {
  const btn = document.getElementById('btnPrompts');
  if (!btn) return;
  const onPrompts = ['prompts', 'promptEdit', 'promptTrash'].includes(screenName);
  if (onPrompts) {
    // On prompts screen → button shows "Перенос/Transfer" → click returns to main
    btn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
        <path d="M1.5 3.5H9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        <path d="M7 1.5L9.5 3.5L7 5.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M9.5 7.5H2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        <path d="M4 5.5L1.5 7.5L4 9.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>${PR_i18n.t('nav.transfer')}</span>`;
    btn.style.background = '';
    btn.style.border = '';
    btn.style.boxShadow = '';
    btn.onclick = (e) => { e.stopPropagation(); showScreen('main'); };
  } else {
    // On main/transfer screen → button shows "Промпты/Prompts" → click goes to prompts
    btn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <rect x="1.5" y="0.5" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
        <path d="M4 3.5h4M4 5.5h4M4 7.5h2" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
      </svg>
      <span>${PR_i18n.t('prompts.nav_label')}</span>`;
    btn.style.background = '';
    btn.style.border = '';
    btn.style.boxShadow = '';
    btn.onclick = (e) => { e.stopPropagation(); showScreen('prompts'); };
  }
}

// btnPrompts click is managed dynamically by _updatePromptsBtn() via btn.onclick
// btnPromptsBack was removed from DOM (header button handles both directions)
document.getElementById('btnAccount')?.addEventListener('click',      () => showScreen('settings'));
document.getElementById('btnHistory')?.addEventListener('click',      () => showScreen('history'));
document.getElementById('btnMap')?.addEventListener('click',          () => showScreen('map'));
document.getElementById('btnTrash')?.addEventListener('click',        () => showScreen('trash'));
document.getElementById('btnSettings')?.addEventListener('click',     () => showScreen('settings'));
document.getElementById('btnHistBack')?.addEventListener('click',     () => showScreen('main'));
document.getElementById('btnMapBack')?.addEventListener('click',      () => showScreen('main'));
document.getElementById('btnTrashBack')?.addEventListener('click',    () => showScreen('main'));
document.getElementById('btnSettingsBack')?.addEventListener('click', () => showScreen('main'));
document.getElementById('btnDonate')?.addEventListener('click',       () => showScreen('donate'));
document.getElementById('btnBug')?.addEventListener('click',          () => showScreen('bug'));
document.getElementById('btnDonateBack')?.addEventListener('click',   () => showScreen('main'));
// Donate accordion toggle
document.getElementById('screenDonate')?.querySelectorAll('.donate-acc-hdr').forEach(hdr => {
  hdr.addEventListener('click', () => {
    hdr.closest('.donate-section')?.classList.toggle('collapsed');
  });
});

// Crypto wallet copy buttons
document.getElementById('screenDonate')?.addEventListener('click', e => {
  const btn = e.target.closest('.crypto-copy');
  if (!btn) return;
  navigator.clipboard.writeText(btn.dataset.addr).then(() => {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  }).catch(() => {});
});

document.getElementById('btnBugBack')?.addEventListener('click',      () => showScreen('main'));

// ═══════════════════════════════════════════════════════════
// MAP SCREEN (popup inline) — uses PR_MapRenderer
// ═══════════════════════════════════════════════════════════
let _mapRenderer = null;

async function _initMapScreen() {
  const canvas   = document.getElementById('mapCanvasEl');
  const svgEl    = document.getElementById('mapSvgEl');
  const emptyEl  = document.getElementById('mapEmptyEl');
  if (!canvas || !svgEl) return;

  const _MAP_FIELDS = ['snapshot_id','parent_id','project','created_at',
    'source_host','target_host','size_bytes','transfer_id','parent_transfer_id'];
  const snaps    = await SessionPortDB.listAll({ limit: 0, fields: _MAP_FIELDS }).catch(() => []);
  const activeId = await SessionPortDB.getActive().catch(() => null);
  const { pr_manual_links: manualLinks = [] } = await new Promise(r =>
    chrome.storage.local.get('pr_manual_links', r));

  if (!_mapRenderer) {
    _mapRenderer = new PR_MapRenderer(canvas, svgEl, { emptyEl, initX: 20, initY: 20 });
    _mapRenderer.onNodeClick = snap => _loadFromMapInline(snap);
  }
  _mapRenderer.draw(snaps, activeId, manualLinks);

  // Project filter buttons
  _buildMapProjSel(snaps);
}

function _buildMapProjSel(snaps) {
  const sel = document.getElementById('mapProjSel');
  if (!sel) return;
  const projs   = [...new Set(snaps.map(s => s.project).filter(Boolean))];
  const isLight = document.body.classList.contains('light');
  const bg  = isLight ? '#f3f4f6' : '#161822';
  const brd = isLight ? '#e5e7eb' : '#1e2028';
  const clr = isLight ? '#4b5563' : '#6b7280';
  const bgA = isLight ? '#dcfce7' : '#1a3a2a';
  const brdA = isLight ? '#86efac' : '#22c55e44';
  const clrA = isLight ? '#166534' : '#4ade80';
  const style = (active) =>
    `padding:2px 7px;border-radius:4px;font-size:10px;cursor:pointer;font-family:inherit;` +
    `background:${active ? bgA : bg};border:1px solid ${active ? brdA : brd};color:${active ? clrA : clr};`;
  const cur = _mapRenderer?.filter;
  sel.innerHTML = `<button data-mproj="__all__" style="${style(!cur)}">${PR_i18n.t('map.all')}</button>` +
    projs.map(p =>
      `<button data-mproj="${PR_Utils.esc(p)}" style="${style(cur === p)}">${PR_Utils.esc(p.length > 16 ? p.slice(0, 16) + '…' : p)}</button>`
    ).join('');
  sel.onclick = e => {
    const btn = e.target.closest('[data-mproj]');
    if (!btn) return;
    const proj = btn.dataset.mproj === '__all__' ? null : btn.dataset.mproj;
    if (_mapRenderer) _mapRenderer.setFilter(proj);
    _buildMapProjSel(_mapRenderer?.snaps || []);
  };
}

function _loadFromMapInline(snap) {
  // Selection ring already set in renderer before onNodeClick fires — just show info panel
  _showMapNodeInfo(snap);
}

function _showMapNodeInfo(snap) {
  const panel = document.getElementById('mapNodeInfo');
  if (!panel) return;

  document.getElementById('mapInfoProj').textContent = snap.project || PR_i18n.t('map.no_project');
  document.getElementById('mapInfoDate').textContent = PR_Utils.fmtDate(snap.created_at || '');
  const kb = ((snap.size_bytes || 0) / 1024).toFixed(1);
  const src = snap.source_host || '';
  const tgt = snap.target_host ? ' → ' + snap.target_host : '';
  const metaEl = document.getElementById('mapInfoMeta');
  const baseMeta = src + tgt + ' · ' + kb + ' KB';
  if (metaEl) metaEl.textContent = baseMeta;
  panel.classList.add('visible');

  if (snap.snapshot_id) {
    chrome.runtime.sendMessage({ action: 'LIST_FILES', snapshot_id: snap.snapshot_id }, resp => {
      if (chrome.runtime.lastError || !metaEl) return;
      const n = (resp?.files || []).length;
      if (n > 0) metaEl.textContent = baseMeta + ' · 📎 ' + n;
    });
  }

  // Replace button to avoid stacking listeners across re-renders
  const oldBtn = document.getElementById('mapInfoLoad');
  if (oldBtn) {
    const btn = oldBtn.cloneNode(true);
    oldBtn.replaceWith(btn);
    btn.id = 'mapInfoLoad';
    btn.addEventListener('click', async () => {
      let fullSnap = snap;
      if (!snap.payload && snap.snapshot_id) {
        fullSnap = await SessionPortDB.getSnapshot(snap.snapshot_id);
        if (!fullSnap) { setStatus(PR_i18n.t('status.snap_not_found'), 'error'); return; }
      }
      await new Promise(res => chrome.storage.local.set({
        flow_state: { ...PR_Utils.snapToFlowState(fullSnap), from_history: true }
      }, res));
      await SessionPortDB.setActive(fullSnap.snapshot_id);
      if (_mapRenderer) {
        _mapRenderer.activeId = fullSnap.snapshot_id;
        _mapRenderer._render();
      }
      panel.classList.remove('visible');
      showScreen('main');
      showPastePanel('paste_msg.from_map');
      if (typeof _fillSnapCard === 'function') _fillSnapCard();
    });
  }
}

// Zoom buttons
document.getElementById('mapZoomIn')?.addEventListener('click',    () => { _mapRenderer?.zoom(1.2); });
document.getElementById('mapZoomOut')?.addEventListener('click',   () => { _mapRenderer?.zoom(0.8); });
document.getElementById('mapZoomReset')?.addEventListener('click', () => { _mapRenderer?.reset(20, 20); });

// Map theme toggle (внутри screenMap)
document.getElementById('mapThemeToggle')?.addEventListener('click', () => {
  const light = !document.body.classList.contains('light');
  document.body.classList.toggle('light', light);
  const t  = document.getElementById('mapThemeToggle');
  const th = document.getElementById('mapThemeThumb');
  if (t)  t.style.background = light ? '#aaff00' : '#334155';
  if (th) { th.style.left = light ? '14px' : '2px'; th.style.background = light ? '#fff' : '#94a3b8'; }
  PR_Utils.saveTheme(light);
  applyPopupTheme(light);
});

document.getElementById('mapBtnBranch')?.addEventListener('click', () => {
  PR_Utils.customPrompt(PR_i18n.t('map.branch_prompt'), async name => {
    if (!name?.trim()) return;
    const id = await SessionPortDB.getActive();
    if (!id) { setStatus(PR_i18n.t('map.no_snap_err'), 'error'); return; }
    await SessionPortDB.fork(id, name.trim());
    _initMapScreen();
  });
});
document.getElementById('mapBtnDashboard')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html#map') });
});
// ── Link mode ───────────────────────────────────────────────
let _linkMode   = false;
let _linkFromId = null;

function _setLinkHint(text) {
  const el = document.getElementById('mapLinkHint');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('visible', !!text);
}

function _exitLinkMode() {
  _linkMode   = false;
  _linkFromId = null;
  document.getElementById('mapBtnLink')?.classList.remove('link-active');
  _setLinkHint('');
  if (_mapRenderer && _mapRenderer._prevOnNodeClick !== undefined) {
    _mapRenderer.onNodeClick = _mapRenderer._prevOnNodeClick;
    delete _mapRenderer._prevOnNodeClick;
  }
  if (document._linkEscHandler) {
    document.removeEventListener('keydown', document._linkEscHandler);
    delete document._linkEscHandler;
  }
}

async function _completeLinkMode(fromId, toId) {
  _exitLinkMode();
  PR_Utils.customPrompt(PR_i18n.t('map.link_comment'), async comment => {
    const link = { from_id: fromId, to_id: toId,
      comment: comment?.trim() || '', created_at: new Date().toISOString() };
    const { pr_manual_links: existing = [] } = await new Promise(r =>
      chrome.storage.local.get('pr_manual_links', r));
    existing.push(link);
    await new Promise(r => chrome.storage.local.set({ pr_manual_links: existing }, r));
    _initMapScreen();
  });
}

function _enterLinkMode(fromId) {
  _linkMode = true;
  document.getElementById('mapBtnLink').classList.add('link-active');

  // Escape cancels
  document._linkEscHandler = e => { if (e.key === 'Escape') _exitLinkMode(); };
  document.addEventListener('keydown', document._linkEscHandler);

  // Override node click — restore after use
  _mapRenderer._prevOnNodeClick = _mapRenderer.onNodeClick;

  if (fromId) {
    // Scenario B: node already selected — pick target only
    _linkFromId = fromId;
    _setLinkHint(PR_i18n.t('map.link_hint3'));
    _mapRenderer.onNodeClick = snap => {
      if (snap.snapshot_id === _linkFromId) return;
      const from = _linkFromId;
      _completeLinkMode(from, snap.snapshot_id);
    };
  } else {
    // Scenario A: nothing selected — pick source first, then target
    _setLinkHint(PR_i18n.t('map.link_hint1'));
    _mapRenderer.onNodeClick = snap => {
      _linkFromId = snap.snapshot_id;
      _mapRenderer.selectNode(_linkFromId);
      _setLinkHint(PR_i18n.t('map.link_hint2'));
      _mapRenderer.onNodeClick = snap2 => {
        if (snap2.snapshot_id === _linkFromId) return;
        const from = _linkFromId;
        _completeLinkMode(from, snap2.snapshot_id);
      };
    };
  }
}

document.getElementById('mapBtnLink')?.addEventListener('click', () => {
  if (_linkMode) { _exitLinkMode(); return; }
  if (!_mapRenderer) return;
  const alreadySelected = _mapRenderer.selectedId;
  _enterLinkMode(alreadySelected || null);
});

document.getElementById('mapBtnNew')?.addEventListener('click', () => {
  PR_Utils.customPrompt(PR_i18n.t('map.new_proj_prompt'), name => {
    if (!name?.trim()) return;
    const n = name.trim();
    if (typeof allProjects !== 'undefined' && !allProjects.includes(n)) allProjects.push(n);
    chrome.storage.local.get('pr_projects', r => {
      const saved = r.pr_projects || [];
      if (!saved.includes(n)) saved.push(n);
      chrome.storage.local.set({ pr_projects: saved, pr_active_project: n });
    });
    currentProject = n;
    const nameEl = document.getElementById('projName');
    if (nameEl) nameEl.textContent = n.length > 28 ? n.slice(0, 28) + '…' : n;
    renderProjectDropdown();
    _initMapScreen();
  });
});

// ── Reactive counter update in main screen ──────────────────
chrome.storage.onChanged.addListener(changes => {
  if (changes.snapshot_added_at) {
    SessionPortDB.listAll({ limit: 0, fields: ['size_bytes'] }).then(snaps => {
      const el = document.getElementById('histCount');
      if (el) el.textContent = snaps.length;
      _updateStorageBar(snaps);
    }).catch(() => {});
  }
});

// ═══════════════════════════════════════════════════════════
// MAIN INIT
// ═══════════════════════════════════════════════════════════
chrome.storage.local.get(['flow_state'], res => {
  const state = res.flow_state || {};

  if (state.status === 'READY_TO_INJECT' && state.payload) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      let currentHost = '';
      try { currentHost = new URL(tabs[0]?.url || '').hostname; } catch (_) {}
      if (state.source_host && state.source_host === currentHost) {
        showPastePanel('paste_msg.src_warn');
      } else {
        showPastePanel();
      }
      // Fill snap card with payload details
      if (typeof _fillSnapCard === 'function') _fillSnapCard();
    });
  }

  // Apply hide-test setting on startup
  chrome.storage.local.get('pr_hide_test', r => {
    const strip = document.querySelector('.test-strip');
    if (strip && r.pr_hide_test) strip.style.display = 'none';
  });

  // Onboarding: show spotlight tour on every launch unless disabled in settings
  chrome.storage.local.get('pr_hide_onboard', r => {
    if (!r.pr_hide_onboard && typeof window._startSpotlightTour === 'function') {
      window._startSpotlightTour();
    }
  });

  // Bug-01: single source of truth for version
  const ver = chrome.runtime.getManifest().version;
  const hdrVer = document.getElementById('hdrVer');
  if (hdrVer) hdrVer.textContent = 'v' + ver;

  // v1.2: migrate → init project bar
  SessionPortDB.migrateFromFlowState().catch(err => console.warn('[PR] migration failed:', err)).finally(() => initProjectBar());

  // history counter
  SessionPortDB.listAll({ limit: 0, fields: ['size_bytes'] }).then(snaps => {
    const el = document.getElementById('histCount');
    if (el) el.textContent = snaps.length;
    _updateStorageBar(snaps);
  }).catch(() => {});
});

// ── Storage usage estimation ────────────────────────────────
async function _updateStorageBar(snaps) {
  const fill = document.getElementById('storageFill');
  const text = document.getElementById('storageText');
  if (!fill || !text) return;

  // Get real quota from browser
  let quota = 0, usage = 0;
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      quota = est.quota || 0;
      usage = est.usage || 0;
    }
  } catch (_) {}

  // Fallback: estimate from snapshot sizes if API unavailable
  const snapBytes = snaps.reduce((sum, s) => sum + (s.size_bytes || 0), 0);
  if (!quota) {
    // Conservative fallback: assume 500 MB
    quota = 500 * 1024 * 1024;
    usage = snapBytes;
  }

  const pct = Math.min(100, (usage / quota) * 100);
  fill.style.width = pct + '%';

  // UI-20: three-stage colour gradient: ok → moderate (50%) → warn (70%) → critical (90%)
  const modPct = 50, warnPct = 70, critPct = 90;
  fill.className = 'storage-fill' +
    (pct >= critPct ? ' critical' : pct >= warnPct ? ' warn' : pct >= modPct ? ' moderate' : '');

  const usedMB  = (usage / (1024 * 1024)).toFixed(1);
  const quotaMB = (quota / (1024 * 1024)).toFixed(0);
  text.textContent = `${usedMB} / ${quotaMB} MB`;

  if (pct >= critPct) {
    setStatus(PR_i18n.t('status.storage_crit', { used: usedMB, total: quotaMB }), 'error');
  } else if (pct >= warnPct) {
    setStatus(PR_i18n.t('status.storage_warn', { used: usedMB, total: quotaMB }), 'working');
  }
}

// ═══════════════════════════════════════════════════════════
// PANEL VISIBILITY — сброс UI при сворачивании/разворачивании
// ═══════════════════════════════════════════════════════════
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Панель свёрнута — скрываем paste panel и очищаем файлы визуально
    hidePastePanel();
    if (typeof renderFiles === 'function') renderFiles([]);
    return;
  }
  // Панель развёрнута — восстанавливаем состояние из storage
  chrome.storage.local.get(['flow_state'], res => {
    const state = res.flow_state || {};
    // Если overlay показан — не восстанавливаем ничего
    const oS = document.getElementById('overlaySimple');
    const oE = document.getElementById('overlayExtended');
    if ((oS && oS.style.display !== 'none') || (oE && oE.style.display !== 'none')) return;

    if (state.status === 'READY_TO_INJECT' && state.payload) {
      showPastePanel();
      // Загружаем файлы только если paste panel открыта и dropzone нужен
      if (typeof loadAttachedFiles === 'function') loadAttachedFiles();
    } else if (state.status === 'PASTED') {
      showPastePanel();
    }
    // Если IDLE — не загружаем файлы, не показываем paste panel
  });
});

// ═══════════════════════════════════════════════════════════
// RESTORE LAST SCREEN
// ═══════════════════════════════════════════════════════════
chrome.storage.local.get('last_screen', res => {
  if (res.last_screen && PERSISTENT_SCREENS.includes(res.last_screen) && res.last_screen !== 'main') {
    showScreen(res.last_screen);
  } else {
    // Init button state for main screen on first open
    _updatePromptsBtn('main');
  }
});
