/**
 * SessionPort — settings.js
 * Аккаунт и настройки: переключение вкладок, тема.
 */

// ─── Tab switching ───────────────────────────────────────

function _switchSettTab(tab) {
  const isAccount = tab === 'account';

  const tabAcc  = document.getElementById('settTabAccount');
  const tabPref = document.getElementById('settTabPrefs');
  const panAcc  = document.getElementById('settPanelAccount');
  const panPref = document.getElementById('settPanelPrefs');

  if (tabAcc)  { tabAcc.className  = 'trans-tab' + (isAccount ? ' active-account' : ''); }
  if (tabPref) { tabPref.className = 'trans-tab' + (!isAccount ? ' active-ext' : ''); }
  if (panAcc)  panAcc.style.display  = isAccount ? '' : 'none';
  if (panPref) panPref.style.display = isAccount ? 'none' : '';
}

document.getElementById('settTabAccount')?.addEventListener('click', () => _switchSettTab('account'));
document.getElementById('settTabPrefs')?.addEventListener('click',   () => _switchSettTab('prefs'));

// ─── Init (called by showScreen) ─────────────────────────


function _applyHideTest(hidden) {
  const strip = document.querySelector('.test-strip');
  if (strip) strip.style.display = hidden ? 'none' : '';
  const toggle = document.getElementById('settHideTestToggle');
  const thumb  = document.getElementById('settHideTestThumb');
  if (toggle) toggle.style.background = hidden ? '#aaff00' : '#334155';
  if (thumb)  thumb.style.left        = hidden ? '14px'   : '2px';
}

function initSettingsScreen() {
  // Sync theme toggle state with current body class
  const isLight = document.body.classList.contains('light');
  const thumb   = document.getElementById('settThemeThumb');
  const toggle  = document.getElementById('settThemeToggle');
  if (thumb)  thumb.style.left       = isLight ? '14px' : '2px';
  if (toggle) toggle.style.background = isLight ? '#aaff00' : '#334155';

  // Sync language selector (hidden select + custom dropdown)
  const langSel = document.getElementById('settLangSelect');
  if (langSel) langSel.value = PR_i18n.lang;
  _syncLangDropLabel(PR_i18n.lang);

  // Sync hide-test toggle
  chrome.storage.local.get('pr_hide_test', r => {
    _applyHideTest(!!r.pr_hide_test);
  });

  // Sync Google Drive state, then auto-sync the canonical file in the background
  if (typeof gdrive_getState === 'function') { _gdRefreshUI(); _gdAutoSync(); }
}

function _syncLangDropLabel(lang) {
  const label = document.getElementById('langDropLabel');
  const item  = document.querySelector(`.lang-drop-item[data-lang="${lang}"]`);
  if (label && item) label.textContent = item.textContent;
  document.querySelectorAll('.lang-drop-item').forEach(i => {
    i.classList.toggle('active', i.dataset.lang === lang);
  });
}

document.getElementById('settLangSelect')?.addEventListener('change', function() {
  PR_i18n.setLang(this.value);
});

// ─── Custom language dropdown ────────────────────────────

(function() {
  const btn  = document.getElementById('langDropBtn');
  const menu = document.getElementById('langDropMenu');
  const sel  = document.getElementById('settLangSelect');
  if (!btn || !menu || !sel) return;

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = menu.style.display !== 'none';
    menu.style.display = isOpen ? 'none' : 'block';
    btn.classList.toggle('open', !isOpen);
  });

  menu.querySelectorAll('.lang-drop-item').forEach(item => {
    item.addEventListener('click', () => {
      const lang = item.dataset.lang;
      sel.value = lang;
      sel.dispatchEvent(new Event('change'));
      _syncLangDropLabel(lang);
      menu.style.display = 'none';
      btn.classList.remove('open');
    });
  });

  document.addEventListener('click', () => {
    menu.style.display = 'none';
    btn.classList.remove('open');
  });
})();

// ─── Spotlight tour ───────────────────────────────────────

(function () {
  const STRINGS = {
    ru: {
      back: '← Назад', skip: 'Пропустить', next: 'Далее →', done: 'Начать работу →',
      0: { t: 'Приватность и безопасность', d: 'Все снимки хранятся только в вашем браузере — не на серверах. Резервные копии создаются в вашем личном Google Drive. Расширение имеет доступ только к файлам, которые само создало.' },
      1: { t: 'Тест автовставки',    d: 'Нажмите кнопку — расширение загрузит тестовый снимок и вставит его в поле ввода AI. Проверьте что вставка работает на этом сайте. История не засоряется. Тест можно скрыть в настройках.' },
      2: { t: 'Перенос контекста',   d: '<strong>Простой:</strong> 1 шаг — модель создаёт JSON-снимок, расширение захватывает его автоматически.<br><strong>Расширенный:</strong> 3 шага с анализом и уточнением якорей контекста.<br>К снимку можно прикрепить любые файлы: фото, архивы, документы — чтобы сохранить важные данные или промежуточные результаты.' },
      3: { t: 'Вставка в новый чат', d: 'После захвата снимка откройте расширение в любом AI-чате. Здесь появятся кнопки вставки для каждого шага переноса — расширение само найдёт поле ввода и вставит контекст.' },
      4: { t: 'История переносов',   d: 'Все снимки хранятся локально в IndexedDB. Поиск, фильтры по проекту, мягкое удаление с корзиной и восстановлением.' },
      5: { t: 'Майнд карта',         d: 'Граф всех переносов — видно как развивался проект, ветки и форки. Кликните на узел чтобы восстановить снимок того момента. Перетаскивайте и масштабируйте.' },
      6: { t: 'Поддержка проекта',   d: 'SessionPort бесплатный и open-source. Если инструмент полезен — поддержите разработку. Это помогает выпускать обновления быстрее.' },
      7: { t: 'Корзина',             d: 'Удалённые снимки хранятся в корзине — их можно восстановить в любой момент. Если настроен бэкап Google Drive, снимки также доступны там даже после очистки корзины.' },
    },
    en: {
      back: '← Back', skip: 'Skip', next: 'Next →', done: 'Start working →',
      0: { t: 'Privacy & Security',   d: 'All snapshots are stored only in your browser — not on any server. Backups go to your personal Google Drive. The extension can only access files it created itself.' },
      1: { t: 'Auto-paste test',      d: 'Click this button — the extension loads a test snapshot and pastes it into the AI input. Verify injection works on this site. History is not affected. The test button can be hidden in Settings.' },
      2: { t: 'Context capture',      d: '<strong>Simple:</strong> 1 step — the model generates a JSON snapshot, captured automatically.<br><strong>Extended:</strong> 3 steps with analysis and anchor refinement.<br>Attach any files to a snapshot: photos, archives, documents — to preserve important data or work-in-progress.' },
      3: { t: 'Paste into new chat',  d: 'After capturing a snapshot, open the extension in any AI chat. Paste buttons for each transfer step appear here — the extension finds the input field and injects the context automatically.' },
      4: { t: 'Transfer history',     d: 'All snapshots are stored locally in IndexedDB. Search, project filters, soft-delete with trash and restore.' },
      5: { t: 'Mind map',             d: 'Graph of all transfers — see how the project evolved, branches and forks. Click any node to restore that snapshot. Pan and zoom freely.' },
      6: { t: 'Support the project',  d: 'SessionPort is free and open-source. If the tool is useful — support development. It helps release updates faster.' },
      7: { t: 'Trash',                d: 'Deleted snapshots are kept in the trash — you can restore them any time. If Google Drive backup is set up, snapshots are also available there even after emptying the trash.' },
    },
    de: {
      back: '← Zurück', skip: 'Überspringen', next: 'Weiter →', done: 'Loslegen →',
      0: { t: 'Datenschutz & Sicherheit', d: 'Alle Snapshots werden nur in Ihrem Browser gespeichert — nicht auf Servern. Backups gehen in Ihre persönliche Google Drive. Die Erweiterung kann nur auf Dateien zugreifen, die sie selbst erstellt hat.' },
      1: { t: 'Auto-Paste-Test',         d: 'Klicken Sie — die Erweiterung lädt einen Test-Snapshot und fügt ihn in das KI-Eingabefeld ein. Prüfen Sie, ob die Einfügung funktioniert. Der Verlauf bleibt unberührt. Die Schaltfläche kann in den Einstellungen ausgeblendet werden.' },
      2: { t: 'Kontextübertragung',      d: '<strong>Einfach:</strong> 1 Schritt — das Modell erstellt einen JSON-Snapshot, automatisch erfasst.<br><strong>Erweitert:</strong> 3 Schritte mit Analyse und Ankerpunktverfeinerung.<br>Hängen Sie beliebige Dateien an: Fotos, Archive, Dokumente — um wichtige Daten zu sichern.' },
      3: { t: 'In neuen Chat einfügen',  d: 'Nach der Erfassung öffnen Sie die Erweiterung in einem KI-Chat. Einfüge-Schaltflächen für jeden Übertragungsschritt erscheinen hier — die Erweiterung findet das Eingabefeld automatisch.' },
      4: { t: 'Übertragungsverlauf',     d: 'Alle Snapshots werden lokal in IndexedDB gespeichert. Suche, Projektfilter, sanftes Löschen mit Papierkorb und Wiederherstellung.' },
      5: { t: 'Mindmap',                 d: 'Diagramm aller Übertragungen — verfolgen Sie die Projektentwicklung, Zweige und Forks. Klicken Sie auf einen Knoten, um diesen Snapshot wiederherzustellen. Schwenken und zoomen.' },
      6: { t: 'Projekt unterstützen',    d: 'SessionPort ist kostenlos und Open-Source. Wenn das Tool nützlich ist — unterstützen Sie die Entwicklung. Das hilft, Updates schneller zu veröffentlichen.' },
      7: { t: 'Papierkorb',              d: 'Gelöschte Snapshots bleiben im Papierkorb — Sie können sie jederzeit wiederherstellen. Wenn Google Drive-Backup eingerichtet ist, sind Snapshots auch dort verfügbar, selbst nach dem Leeren des Papierkorbs.' },
    },
    fr: {
      back: '← Retour', skip: 'Passer', next: 'Suivant →', done: 'Commencer →',
      0: { t: 'Confidentialité & Sécurité', d: 'Tous les instantanés sont stockés uniquement dans votre navigateur — pas sur des serveurs. Les sauvegardes vont sur votre Google Drive personnel. L\'extension n\'accède qu\'aux fichiers qu\'elle a créés elle-même.' },
      1: { t: 'Test de collage auto',       d: 'Cliquez — l\'extension charge un instantané de test et le colle dans le champ IA. Vérifiez que l\'injection fonctionne. L\'historique n\'est pas affecté. Le bouton peut être masqué dans les paramètres.' },
      2: { t: 'Capture de contexte',        d: '<strong>Simple :</strong> 1 étape — le modèle génère un instantané JSON, capturé automatiquement.<br><strong>Étendu :</strong> 3 étapes avec analyse et affinement des ancres.<br>Joignez des fichiers au snapshot : photos, archives, documents — pour conserver des données importantes.' },
      3: { t: 'Coller dans un nouveau chat', d: 'Après la capture, ouvrez l\'extension dans un chat IA. Les boutons de collage pour chaque étape apparaissent ici — l\'extension trouve le champ et injecte le contexte automatiquement.' },
      4: { t: 'Historique des transferts',  d: 'Tous les instantanés sont stockés localement dans IndexedDB. Recherche, filtres par projet, suppression douce avec corbeille et restauration.' },
      5: { t: 'Carte mentale',              d: 'Graphe de tous les transferts — voyez l\'évolution du projet, branches et forks. Cliquez sur un nœud pour restaurer cet instantané. Panoramique et zoom.' },
      6: { t: 'Soutenir le projet',         d: 'SessionPort est gratuit et open-source. Si l\'outil est utile — soutenez le développement. Cela aide à publier des mises à jour plus rapidement.' },
      7: { t: 'Corbeille',                  d: 'Les instantanés supprimés sont conservés dans la corbeille — vous pouvez les restaurer à tout moment. Si la sauvegarde Google Drive est configurée, les instantanés y sont disponibles même après avoir vidé la corbeille.' },
    },
    es: {
      back: '← Atrás', skip: 'Omitir', next: 'Siguiente →', done: 'Empezar →',
      0: { t: 'Privacidad y Seguridad',   d: 'Todos los instantáneos se almacenan solo en su navegador — no en servidores. Las copias de seguridad van a su Google Drive personal. La extensión solo puede acceder a los archivos que creó ella misma.' },
      1: { t: 'Prueba de pegado auto',    d: 'Haga clic — la extensión carga un instantáneo de prueba y lo pega en el campo de IA. Verifique que funciona. El historial no se ve afectado. El botón de prueba puede ocultarse en Configuración.' },
      2: { t: 'Captura de contexto',      d: '<strong>Simple:</strong> 1 paso — el modelo genera un instantáneo JSON, capturado automáticamente.<br><strong>Extendido:</strong> 3 pasos con análisis y refinamiento de anclajes.<br>Adjunte archivos al snapshot: fotos, archivos, documentos — para conservar datos importantes.' },
      3: { t: 'Pegar en nuevo chat',      d: 'Después de capturar, abra la extensión en cualquier chat IA. Aquí aparecen botones de pegado para cada paso — la extensión encuentra el campo e inyecta el contexto automáticamente.' },
      4: { t: 'Historial de transferencias', d: 'Todos los instantáneos se almacenan localmente en IndexedDB. Búsqueda, filtros de proyecto, eliminación suave con papelera y restauración.' },
      5: { t: 'Mapa mental',              d: 'Gráfico de todas las transferencias — vea cómo evolucionó el proyecto, ramas y bifurcaciones. Haga clic en un nodo para restaurar ese instantáneo. Desplazar y zoom.' },
      6: { t: 'Apoyar el proyecto',       d: 'SessionPort es gratuito y de código abierto. Si la herramienta es útil — apoye el desarrollo. Ayuda a lanzar actualizaciones más rápido.' },
      7: { t: 'Papelera',                 d: 'Los instantáneos eliminados se guardan en la papelera — puede restaurarlos en cualquier momento. Si la copia de seguridad de Google Drive está configurada, también están disponibles allí incluso después de vaciar la papelera.' },
    },
    zh: {
      back: '← 返回', skip: '跳过', next: '下一步 →', done: '开始使用 →',
      0: { t: '隐私与安全',    d: '所有快照仅存储在您的浏览器中——不在任何服务器上。备份保存到您的个人Google Drive。扩展程序只能访问它自己创建的文件。' },
      1: { t: '自动粘贴测试',  d: '点击此按钮——扩展程序加载测试快照并粘贴到AI输入框。验证注入是否有效。历史记录不受影响。测试按钮可在设置中隐藏。' },
      2: { t: '上下文捕获',    d: '<strong>简单模式：</strong>1步——模型生成JSON快照，自动捕获。<br><strong>扩展模式：</strong>3步，含分析和锚点优化。<br>可向快照附加任意文件：照片、压缩包、文档——用于保存重要数据或中间成果。' },
      3: { t: '粘贴到新对话',  d: '捕获快照后，在任意AI对话中打开扩展程序。此处将出现每个传输步骤的粘贴按钮——扩展程序自动找到输入框并注入上下文。' },
      4: { t: '传输历史',      d: '所有快照本地存储在IndexedDB中。支持搜索、项目筛选、软删除（含回收站和恢复功能）。' },
      5: { t: '思维导图',      d: '所有传输的图谱——了解项目如何演进、分支和分叉。点击节点恢复该时刻的快照。支持平移和缩放。' },
      6: { t: '支持项目',      d: 'SessionPort免费且开源。如果工具对您有帮助——请支持开发。这有助于更快发布更新。' },
      7: { t: '回收站',        d: '删除的快照保存在回收站中——随时可以恢复。如果设置了Google Drive备份，即使清空回收站后，快照也可在那里找到。' },
    },
    ja: {
      back: '← 戻る', skip: 'スキップ', next: '次へ →', done: '始める →',
      0: { t: 'プライバシーとセキュリティ', d: 'すべてのスナップショットはブラウザにのみ保存されます——サーバーには保存されません。バックアップはあなたの個人Google Driveに送られます。拡張機能は自分で作成したファイルにのみアクセスできます。' },
      1: { t: '自動貼り付けテスト',        d: 'このボタンをクリック——拡張機能がテストスナップショットをAI入力フィールドに貼り付けます。注入が機能するか確認してください。履歴は影響を受けません。テストボタンは設定で非表示にできます。' },
      2: { t: 'コンテキストキャプチャ',    d: '<strong>シンプル：</strong>1ステップ——モデルがJSONスナップショットを生成し、自動キャプチャ。<br><strong>拡張：</strong>3ステップのアンカー分析と改良。<br>スナップショットにファイルを添付できます：写真、アーカイブ、ドキュメント——重要なデータを保存するために。' },
      3: { t: '新しいチャットに貼り付け',  d: 'スナップショットを取得後、AIチャットで拡張機能を開きます。各転送ステップの貼り付けボタンがここに表示されます——拡張機能が入力フィールドを自動的に見つけてコンテキストを注入します。' },
      4: { t: '転送履歴',                  d: 'すべてのスナップショットはIndexedDBにローカル保存されます。検索、プロジェクトフィルター、ゴミ箱付きソフト削除と復元。' },
      5: { t: 'マインドマップ',            d: 'すべての転送のグラフ——プロジェクトの発展、ブランチとフォークを確認できます。ノードをクリックしてそのスナップショットを復元。パンとズームが可能。' },
      6: { t: 'プロジェクトを支援',        d: 'SessionPortは無料でオープンソースです。ツールが役立つなら——開発を支援してください。更新をより速くリリースするのに役立ちます。' },
      7: { t: 'ゴミ箱',                    d: '削除されたスナップショットはゴミ箱に保存されます——いつでも復元できます。Google Driveバックアップが設定されている場合、ゴミ箱を空にしても、スナップショットはそこで利用できます。' },
    },
    ko: {
      back: '← 뒤로', skip: '건너뛰기', next: '다음 →', done: '시작하기 →',
      0: { t: '개인정보 보호 및 보안', d: '모든 스냅샷은 브라우저에만 저장됩니다——서버에는 저장되지 않습니다. 백업은 개인 Google Drive에 저장됩니다. 확장 프로그램은 자신이 만든 파일에만 액세스할 수 있습니다.' },
      1: { t: '자동 붙여넣기 테스트', d: '이 버튼 클릭——확장 프로그램이 테스트 스냅샷을 AI 입력 필드에 붙여넣습니다. 주입이 작동하는지 확인하세요. 기록은 영향 받지 않습니다. 테스트 버튼은 설정에서 숨길 수 있습니다.' },
      2: { t: '컨텍스트 캡처',        d: '<strong>간단:</strong> 1단계——모델이 JSON 스냅샷을 생성하고 자동 캡처.<br><strong>확장:</strong> 앵커 분석과 정제를 포함한 3단계.<br>스냅샷에 파일 첨부 가능: 사진, 압축 파일, 문서——중요한 데이터를 보존하기 위해.' },
      3: { t: '새 채팅에 붙여넣기',   d: '스냅샷 캡처 후 AI 채팅에서 확장 프로그램을 엽니다. 각 전송 단계의 붙여넣기 버튼이 여기에 나타납니다——확장 프로그램이 입력 필드를 자동으로 찾아 컨텍스트를 주입합니다.' },
      4: { t: '전송 기록',            d: '모든 스냅샷은 IndexedDB에 로컬로 저장됩니다. 검색, 프로젝트 필터, 휴지통과 복원 기능이 있는 소프트 삭제.' },
      5: { t: '마인드맵',             d: '모든 전송 그래프——프로젝트의 발전, 브랜치와 포크를 확인하세요. 노드를 클릭하여 해당 스냅샷을 복원합니다. 이동 및 확대/축소 가능.' },
      6: { t: '프로젝트 지원',        d: 'SessionPort는 무료 오픈소스입니다. 도구가 유용하다면——개발을 지원해 주세요. 업데이트를 더 빠르게 출시하는 데 도움이 됩니다.' },
      7: { t: '휴지통',               d: '삭제된 스냅샷은 휴지통에 보관됩니다——언제든지 복원할 수 있습니다. Google Drive 백업이 설정된 경우, 휴지통을 비운 후에도 스냅샷을 거기서 찾을 수 있습니다.' },
    },
    pt: {
      back: '← Voltar', skip: 'Pular', next: 'Próximo →', done: 'Começar →',
      0: { t: 'Privacidade e Segurança', d: 'Todos os instantâneos são armazenados apenas no seu navegador — não em servidores. Os backups vão para o seu Google Drive pessoal. A extensão só pode acessar arquivos que ela mesma criou.' },
      1: { t: 'Teste de colagem auto',   d: 'Clique — a extensão carrega um instantâneo de teste e o cola no campo IA. Verifique se a injeção funciona. O histórico não é afetado. O botão de teste pode ser ocultado nas Configurações.' },
      2: { t: 'Captura de contexto',     d: '<strong>Simples:</strong> 1 passo — o modelo gera um instantâneo JSON, capturado automaticamente.<br><strong>Estendido:</strong> 3 passos com análise e refinamento de âncoras.<br>Anexe arquivos ao snapshot: fotos, arquivos, documentos — para preservar dados importantes.' },
      3: { t: 'Colar em novo chat',      d: 'Após capturar um snapshot, abra a extensão em qualquer chat IA. Botões de colagem para cada etapa aparecem aqui — a extensão encontra o campo e injeta o contexto automaticamente.' },
      4: { t: 'Histórico de transferências', d: 'Todos os instantâneos são armazenados localmente em IndexedDB. Pesquisa, filtros por projeto, exclusão suave com lixeira e restauração.' },
      5: { t: 'Mapa mental',             d: 'Gráfico de todas as transferências — veja como o projeto evoluiu, ramificações e forks. Clique em qualquer nó para restaurar esse instantâneo. Panorâmica e zoom.' },
      6: { t: 'Apoiar o projeto',        d: 'SessionPort é gratuito e de código aberto. Se a ferramenta for útil — apoie o desenvolvimento. Isso ajuda a lançar atualizações mais rapidamente.' },
      7: { t: 'Lixeira',                 d: 'Instantâneos excluídos são mantidos na lixeira — você pode restaurá-los a qualquer momento. Se o backup do Google Drive estiver configurado, os instantâneos também estarão disponíveis lá, mesmo após esvaziar a lixeira.' },
    },
  };

  function _expandPasteArea() {
    const el = document.getElementById('sectionPaste');
    if (el) { el.classList.remove('hidden'); el.style.display = ''; el.classList.add('open'); }
  }
  function _collapsePasteArea() {
    const el = document.getElementById('sectionPaste');
    if (el) { el.classList.remove('open'); el.classList.add('hidden'); el.style.display = 'none'; }
  }

  const STEPS = [
    { id: 0, target: null },
    { id: 1, target: '#btnTest',      pos: 'bottom' },
    { id: 2, target: '#transferTabs', pos: 'top'    },
    { id: 3, target: '#sectionPaste', pos: 'top-pin', onEnter: _expandPasteArea, onLeave: _collapsePasteArea },
    { id: 4, target: '#btnHistory',   pos: 'top'    },
    { id: 5, target: '#btnMap',       pos: 'top'    },
    { id: 6, target: '#btnDonate',    pos: 'top'    },
    { id: 7, target: '#btnTrash',     pos: 'bottom' },
  ];
  const TOTAL = STEPS.length;
  let cur = 0, prevEl = null;

  const overlay = document.getElementById('spOverlay');
  const tooltip = document.getElementById('spTooltip');
  const elNum   = document.getElementById('spStepNum');
  const elTitle = document.getElementById('spTitle');
  const elDesc  = document.getElementById('spDesc');
  const elDots  = document.getElementById('spDots');
  const btnBack = document.getElementById('spBack');
  const btnSkip = document.getElementById('spSkip');
  const btnNext = document.getElementById('spNext');

  function _strings() {
    const lang = (typeof PR_i18n !== 'undefined' ? PR_i18n.lang : null) || 'en';
    return STRINGS[lang] || STRINGS.en;
  }

  function _pos(el, hint) {
    tooltip.style.transform = '';
    const tr = el.getBoundingClientRect();
    const tw = tooltip.offsetWidth  || 280;
    const th = tooltip.offsetHeight || 150;
    const vh = window.innerHeight;
    const gap = 12;
    tooltip.classList.remove('arr-top', 'arr-bot');
    let top;
    if (hint === 'top-pin') {
      top = Math.max(8, tr.top - th - 140); tooltip.classList.add('arr-bot');
    } else if (hint === 'bottom' && tr.bottom + gap + th < vh - 6) {
      top = tr.bottom + gap; tooltip.classList.add('arr-top');
    } else if (hint === 'top' && tr.top - gap - th > 6) {
      top = tr.top - gap - th; tooltip.classList.add('arr-bot');
    } else if (tr.bottom + gap + th < vh - 6) {
      top = tr.bottom + gap; tooltip.classList.add('arr-top');
    } else {
      top = Math.max(6, tr.top - gap - th); tooltip.classList.add('arr-bot');
    }
    const left = Math.max(8, Math.min(tr.left, window.innerWidth - tw - 8));
    tooltip.style.top  = top  + 'px';
    tooltip.style.left = left + 'px';
  }

  function _center() {
    tooltip.classList.remove('arr-top', 'arr-bot');
    tooltip.style.top       = '50%';
    tooltip.style.left      = '50%';
    tooltip.style.transform = 'translate(-50%, -50%)';
  }

  function _goTo(idx) {
    const leavingStep = STEPS[cur];
    if (prevEl) { prevEl.classList.remove('sp-highlight'); prevEl = null; }
    if (leavingStep && leavingStep.onLeave) leavingStep.onLeave();
    const step = STEPS[idx];
    if (step.onEnter) step.onEnter();
    const s = _strings();

    elNum.textContent   = (idx + 1) + ' / ' + TOTAL;
    elTitle.textContent = s[step.id].t;
    elDesc.innerHTML    = s[step.id].d;
    elDots.innerHTML    = STEPS.map((_,i) =>
      `<div class="sp-dot${i===idx?' active':''}"></div>`).join('');
    btnBack.textContent = s.back;
    btnSkip.textContent = s.skip;
    btnNext.textContent = idx === TOTAL - 1 ? s.done : s.next;
    btnBack.style.visibility = idx === 0 ? 'hidden' : '';

    cur = idx;
    tooltip.style.opacity = '0';
    tooltip.style.display = 'block';

    if (step.target === null) {
      requestAnimationFrame(() => { _center(); tooltip.style.opacity = '1'; });
    } else {
      const el = document.querySelector(step.target);
      if (!el) { _close(); return; }
      el.classList.add('sp-highlight');
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      prevEl = el;
      requestAnimationFrame(() => requestAnimationFrame(() => { _pos(el, step.pos); tooltip.style.opacity = '1'; }));
    }
  }

  function _close() {
    if (prevEl) { prevEl.classList.remove('sp-highlight'); prevEl = null; }
    _collapsePasteArea();
    if (overlay) overlay.style.display = 'none';
    if (tooltip) { tooltip.style.display = 'none'; tooltip.style.opacity = '0'; }
    chrome.storage.local.set({ pr_hide_onboard: true });
  }

  function startTour() {
    if (!overlay || !tooltip) return;
    const _launch = () => { overlay.style.display = 'block'; setTimeout(() => _goTo(0), 40); };
    const _ready = typeof PR_i18n !== 'undefined' ? PR_i18n.ready : null;
    if (_ready) _ready.then(_launch); else _launch();
  }

  btnNext?.addEventListener('click', () => { if (cur < TOTAL - 1) _goTo(cur + 1); else _close(); });
  btnBack?.addEventListener('click', () => { if (cur > 0) _goTo(cur - 1); });
  btnSkip?.addEventListener('click', _close);
  elDots?.addEventListener('click', e => {
    const d = e.target.closest('.sp-dot');
    if (d) { const i = [...elDots.children].indexOf(d); if (i >= 0) _goTo(i); }
  });

  window._startSpotlightTour = startTour;
})();

// ─── Export / Import ─────────────────────────────────────

function _triggerDownload(json, filename) {
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ─── Export modal ─────────────────────────────────────────

let _exportSnaps  = [];
let _exportSel    = new Set();

function _updateExportModal() {
  const n     = _exportSel.size;
  const total = _exportSnaps.length;
  const countEl  = document.getElementById('exportSelCount');
  const confirmBtn = document.getElementById('exportModalConfirm');
  if (countEl)    countEl.textContent = n + ' / ' + total;
  if (confirmBtn) {
    confirmBtn.textContent = PR_i18n.t('sett.export_btn') + ' (' + n + ')';
    confirmBtn.disabled    = n === 0;
  }
  document.querySelectorAll('.export-snap-cb').forEach(cb => {
    cb.checked = _exportSel.has(cb.dataset.id);
  });
}

async function _openExportModal() {
  const overlay = document.getElementById('exportModalOverlay');
  if (!overlay) return;
  try {

  _exportSnaps = await SessionPortDB.listAll({
    limit: 0, fields: ['snapshot_id','project','created_at','size_bytes','source_host']
  });
  _exportSnaps.sort((a, b) => b.created_at.localeCompare(a.created_at));
  _exportSel   = new Set(_exportSnaps.map(s => s.snapshot_id));

  const list = document.getElementById('exportSnapList');
  if (list) {
    list.innerHTML = _exportSnaps.map(s => {
      const date = PR_Utils.fmtDate(s.created_at);
      const kb   = ((s.size_bytes || 0) / 1024).toFixed(1);
      const proj = PR_Utils.esc(s.project || '—');
      const host = PR_Utils.esc(s.source_host || '');
      return `<label class="export-snap-row">
        <input type="checkbox" class="export-snap-cb" data-id="${s.snapshot_id}" checked>
        <div class="export-snap-info">
          <div class="export-snap-proj">${proj}</div>
          <div class="export-snap-meta">${date} · ${host} · ${kb} KB</div>
        </div>
      </label>`;
    }).join('');

    list.querySelectorAll('.export-snap-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) _exportSel.add(cb.dataset.id);
        else            _exportSel.delete(cb.dataset.id);
        _updateExportModal();
      });
    });
  }

  _updateExportModal();
  overlay.classList.add('open');
  } catch (e) {
    setStatus('Export modal error: ' + e.message, 'error');
  }
}

document.getElementById('settExportBtn')?.addEventListener('click', _openExportModal);
document.getElementById('btnHistExport')?.addEventListener('click', _openExportModal);

document.getElementById('exportModalClose')?.addEventListener('click', () => {
  document.getElementById('exportModalOverlay')?.classList.remove('open');
});
document.getElementById('exportModalCancel')?.addEventListener('click', () => {
  document.getElementById('exportModalOverlay')?.classList.remove('open');
});
document.getElementById('exportSelectAll')?.addEventListener('click', () => {
  _exportSel = new Set(_exportSnaps.map(s => s.snapshot_id));
  _updateExportModal();
});
document.getElementById('exportSelectNone')?.addEventListener('click', () => {
  _exportSel.clear();
  _updateExportModal();
});
document.getElementById('exportModalConfirm')?.addEventListener('click', async () => {
  if (_exportSel.size === 0) return;
  try {
    const filename = 'sessionport-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    const json = _exportSel.size === _exportSnaps.length
      ? await SessionPortDB.exportAll()
      : await SessionPortDB.exportSelected([..._exportSel]);
    _triggerDownload(json, filename);
    setStatus(PR_i18n.t('sett.export_ok'), 'active');
    document.getElementById('exportModalOverlay')?.classList.remove('open');
  } catch (e) {
    setStatus(PR_i18n.t('sett.import_err') + e.message, 'error');
  }
});

document.getElementById('settImportBtn')?.addEventListener('click', () => {
  document.getElementById('settImportFile')?.click();
});

document.getElementById('settImportFile')?.addEventListener('change', async function() {
  const file = this.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const { imported, restored } = await SessionPortDB.importAll(text);
    const key = (restored > 0 && imported === 0) ? 'sett.import_restored' : 'sett.import_ok';
    setStatus(PR_i18n.t(key), 'active');
    SessionPortDB.listAll({ limit: 0, fields: ['size_bytes'] }).then(snaps => {
      const el = document.getElementById('histCount');
      if (el) el.textContent = snaps.length;
      if (typeof _updateStorageBar === 'function') _updateStorageBar(snaps);
    });
  } catch (e) {
    setStatus(PR_i18n.t('sett.import_err') + e.message, 'error');
  }
  this.value = '';
});

// ─── Hide test toggle ────────────────────────────────────

document.getElementById('settHideTestToggle')?.addEventListener('click', () => {
  chrome.storage.local.get('pr_hide_test', r => {
    const next = !r.pr_hide_test;
    chrome.storage.local.set({ pr_hide_test: next });
    _applyHideTest(next);
  });
});

// ─── Google Drive ─────────────────────────────────────────

function _gdFmtDate(ts) {
  if (!ts) return 'Нет бэкапов';
  const d = new Date(ts);
  return d.toLocaleDateString(PR_i18n.fmtDateLocale(), { day: '2-digit', month: 'short' })
    + ' ' + d.toLocaleTimeString(PR_i18n.fmtDateLocale(), { hour: '2-digit', minute: '2-digit' });
}

async function _gdRefreshUI() {
  const state = await gdrive_getState();
  const notConn  = document.getElementById('gdNotConnected');
  const conn     = document.getElementById('gdConnected');
  if (!notConn || !conn) return;

  if (state.connected) {
    notConn.style.display = 'none';
    conn.style.display    = '';
    const emailEl = document.getElementById('gdEmailEl');
    const uidEl   = document.getElementById('gdUidEl');
    const lastEl  = document.getElementById('gdLastBackupEl');
    const avatarEl = document.getElementById('gdAvatarEl');
    if (emailEl) emailEl.textContent = state.email || '—';
    if (uidEl)   uidEl.textContent   = state.userId || '';
    if (lastEl)  lastEl.textContent  = state.lastBackup
      ? 'Последний бэкап: ' + _gdFmtDate(state.lastBackup) : 'Нет бэкапов';
    _gdSetInterval(state.interval || 'off', false);
    if (avatarEl && state.email) avatarEl.textContent = state.email[0].toUpperCase();
  } else {
    notConn.style.display = '';
    conn.style.display    = 'none';
    const notice = document.getElementById('gdSetupNotice');
    if (notice) notice.style.display = gdrive_isConfigured() ? 'none' : '';
  }
}

// Auto-sync the canonical Drive file when the popup opens (if connected and not
// synced in the last minute). Pull → merge → push. Silent: never blocks the UI
// or alerts on transient failure; retries on the next open.
let _gdSyncing = false;
async function _gdAutoSync() {
  if (_gdSyncing || typeof gdrive_syncNow !== 'function') return;
  const st = await gdrive_getState();
  if (!st.connected) return;
  const { gd_last_sync } = await new Promise(r => chrome.storage.local.get('gd_last_sync', r));
  if (gd_last_sync && Date.now() - gd_last_sync < 60_000) return;
  _gdSyncing = true;
  try {
    const res = await gdrive_syncNow();
    if (res.pulled && (res.pulled.added || res.pulled.updated)) {
      chrome.storage.local.set({ snapshot_added_at: Date.now() }); // nudge history view to refresh
    }
    await _gdRefreshUI();
  } catch (e) {
    if (e.message === 'AUTH_EXPIRED') { await gdrive_disconnect(); await _gdRefreshUI(); }
    else console.warn('[SessionPort] auto-sync failed:', e); // visible, non-fatal; retries next open
  } finally {
    _gdSyncing = false;
  }
}

document.getElementById('btnGdSignIn')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnGdSignIn');
  if (btn) { btn.disabled = true; btn.textContent = PR_i18n.t('sett.gd_connecting'); }
  try {
    await gdrive_connect();
    await _gdRefreshUI();
    _gdAutoSync(); // initial pull/push right after connecting
    showToast && showToast(PR_i18n.t('sett.gd_connected'), 'success');
  } catch (e) {
    if (e.message === 'SETUP_REQUIRED') {
      const notice = document.getElementById('gdSetupNotice');
      if (notice) notice.style.display = '';
    } else {
      showToast && showToast(PR_i18n.t('sett.gd_login_err') + e.message, 'error');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 14 14" fill="none"><path d="M13 7.15c0-.5-.04-1-.12-1.5H7v2.84h3.36c-.15.8-.6 1.47-1.26 1.92v1.6h2.04C12.45 10.9 13 9.16 13 7.15z" fill="#4285f4"/><path d="M7 13c1.68 0 3.09-.55 4.12-1.5L9.08 9.9c-.56.38-1.28.6-2.08.6-1.6 0-2.96-1.08-3.44-2.53H1.48v1.64C2.5 11.44 4.62 13 7 13z" fill="#34a853"/><path d="M3.56 7.97c-.12-.36-.19-.74-.19-1.13 0-.4.07-.78.19-1.14V4.06H1.48A6.04 6.04 0 0 0 1 6.84c0 .97.23 1.88.48 2.77l2.08-1.64z" fill="#fbbc05"/><path d="M7 3.43c.9 0 1.7.31 2.33.92l1.75-1.75C9.93 1.56 8.6 1 7 1A6 6 0 0 0 1.48 4.06l2.08 1.64C4.04 4.51 5.4 3.43 7 3.43z" fill="#ea4335"/></svg> ${PR_i18n.t('sett.auth_google')}`;
    }
  }
});

document.getElementById('btnGdSignOut')?.addEventListener('click', async () => {
  try {
    await gdrive_disconnect();
    await _gdRefreshUI();
    showToast && showToast(PR_i18n.t('sett.gd_signed_out'), 'success');
  } catch (e) {
    showToast && showToast(PR_i18n.t('sett.gd_err') + e.message, 'error');
  }
});

// ─── Custom GD interval dropdown ────────────────────────────

function _gdSetInterval(val, save) {
  const label = document.getElementById('gdIntervalLabel');
  const item  = document.querySelector(`.gd-int-item[data-val="${val}"]`);
  if (label && item) label.textContent = item.textContent;
  document.querySelectorAll('.gd-int-item').forEach(i => i.classList.toggle('active', i.dataset.val === val));
  if (!save) return;
  gdrive_setInterval(val).then(() => {
    showToast && showToast(val === 'off' ? 'Автобэкап выключен' : 'Автобэкап: ' + (item?.textContent || val), 'success');
  }).catch(e => showToast && showToast(PR_i18n.t('sett.gd_err') + e.message, 'error'));
}

(function() {
  const btn  = document.getElementById('gdIntervalBtn');
  const menu = document.getElementById('gdIntervalMenu');
  if (!btn || !menu) return;

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = menu.style.display !== 'none';
    menu.style.display = isOpen ? 'none' : 'block';
    btn.classList.toggle('open', !isOpen);
  });

  menu.querySelectorAll('.gd-int-item').forEach(item => {
    item.addEventListener('click', () => {
      _gdSetInterval(item.dataset.val, true);
      menu.style.display = 'none';
      btn.classList.remove('open');
    });
  });

  document.addEventListener('click', () => {
    menu.style.display = 'none';
    btn.classList.remove('open');
  });
})();

document.getElementById('btnGdBackupNow')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnGdBackupNow');
  if (btn) { btn.disabled = true; btn.textContent = PR_i18n.t('hist.loading'); }
  try {
    const result = await gdrive_runBackup();
    await _gdRefreshUI();
    const kb = result.size ? ' (' + (result.size / 1024).toFixed(1) + ' KB)' : '';
    showToast && showToast(PR_i18n.t('sett.gd_backup_saved') + kb, 'success');
  } catch (e) {
    const msg = e.message === 'AUTH_EXPIRED' ? PR_i18n.t('sett.gd_session_expired') : e.message;
    showToast && showToast(PR_i18n.t('sett.gd_backup_err') + msg, 'error');
    if (e.message === 'AUTH_EXPIRED') { await gdrive_disconnect(); await _gdRefreshUI(); }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v7M3 5l3 3 3-3M1 10h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> ${PR_i18n.t('sett.gd_backup_btn')}`;
    }
  }
});

document.getElementById('btnGdRestore')?.addEventListener('click', async () => {
  const list  = document.getElementById('gdBackupList');
  const modal = document.getElementById('gdRestoreModal');
  if (!list || !modal) return;
  list.innerHTML = `<div style="font-size:11px;color:#6b7280;padding:8px 0">${PR_i18n.t('hist.loading')}</div>`;
  modal.classList.add('open');
  try {
    const backups = await gdrive_listBackups();
    if (!backups.length) {
      list.innerHTML = `<div style="font-size:11px;color:#6b7280;padding:8px 0">${PR_i18n.t('sett.gd_no_backups')}</div>`;
      return;
    }
    list.innerHTML = backups.map(f => {
      const kb   = f.size ? (parseInt(f.size) / 1024).toFixed(1) + ' KB' : '—';
      const date = f.createdTime ? new Date(f.createdTime).toLocaleString(PR_i18n.fmtDateLocale()) : '';
      return `<div class="gd-backup-item" data-fid="${PR_Utils.esc(f.id)}">
        <div class="gd-backup-item-name">${PR_Utils.esc(f.name)}</div>
        <div class="gd-backup-item-meta">${date} · ${kb}</div>
      </div>`;
    }).join('');
    list.querySelectorAll('.gd-backup-item').forEach(item => {
      item.addEventListener('click', async () => {
        const fileId = item.dataset.fid;
        modal.classList.remove('open');
        const ok = await PR_Utils.customConfirm(
          PR_i18n.t('sett.gd_restore_msg'),
          { confirmText: PR_i18n.t('sett.gd_restore_btn'), cancelText: PR_i18n.t('dlg.cancel') }
        );
        if (!ok) return;
        try {
          const count = await gdrive_restoreBackup(fileId);
          chrome.storage.local.set({ snapshot_added_at: Date.now() });
          showToast && showToast(PR_i18n.t('sett.gd_restored', { n: count }), 'success');
        } catch (e) {
          showToast && showToast(PR_i18n.t('sett.gd_restore_err') + e.message, 'error');
        }
      });
    });
  } catch (e) {
    list.innerHTML = `<div style="font-size:11px;color:#f87171;padding:8px 0">${PR_i18n.t('sett.gd_err')}${PR_Utils.esc(e.message)}</div>`;
    if (e.message === 'AUTH_EXPIRED') { await gdrive_disconnect(); await _gdRefreshUI(); }
  }
});

document.getElementById('btnGdModalCancel')?.addEventListener('click', () => {
  document.getElementById('gdRestoreModal')?.classList.remove('open');
});

// ─── Theme toggle ────────────────────────────────────────

document.getElementById('settThemeToggle')?.addEventListener('click', () => {
  const isLight = !document.body.classList.contains('light');
  document.body.classList.toggle('light', isLight);

  const toggle = document.getElementById('settThemeToggle');
  const thumb  = document.getElementById('settThemeThumb');
  if (toggle) toggle.style.background = isLight ? '#aaff00' : '#334155';
  if (thumb)  thumb.style.left        = isLight ? '14px' : '2px';

  // Sync main header toggle
  const mainToggle = document.getElementById('themeToggle');
  const mainThumb  = document.getElementById('themeThumb');
  if (mainToggle) mainToggle.style.background = isLight ? '#aaff00' : '#334155';
  if (mainThumb)  mainThumb.style.left        = isLight ? '15px' : '2px';

  PR_Utils.saveTheme(isLight);
  if (typeof applyPopupTheme === 'function') applyPopupTheme(isLight);
});
