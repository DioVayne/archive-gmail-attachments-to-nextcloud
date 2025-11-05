/**
 * ===================================================================================
 * GMAIL ARCHIVER - HOOFDSCRIPT (v3.0)
 * ===================================================================================
 * Dit bestand bevat de *kernlogica* voor Gmail, batching, en het verwerken
 * van threads. Het is agnostisch over *waar* de bestanden worden opgeslagen.
 *
 * Functies:
 * - runTest()
 * - runProduction()
 * - setupTriggerHourly()
 * - testQuery()
 * - testStorageProvider() (vervangt testFlatPut)
 *
 * @see Config.gs (voor alle configuratie)
 * @see Nextcloud_Connector.gs (voor Nextcloud implementatie)
 * @see GoogleDrive_Connector.gs (voor Google Drive implementatie)
 * ===================================================================================
 */

// ===================================================================================
// SCRIPT ENTRYPOINTS (Hoofdfuncties)
// ===================================================================================

/**
 * Draait het script in TEST modus op een enkele thread.
 * Zoekt naar `CONFIG.TEST_MODE_LABEL` en verwerkt de eerste thread die het vindt.
 */
function runTest() {
  Logger.log('runTest() start (Archiver v3.0)');
  const storage = getStorageProvider_(); // Haal de actieve storage provider op

  // Get labels
  const testLabel = getOrCreateLabel_(CONFIG.TEST_MODE_LABEL);
  const processingLabel = getOrCreateLabel_(CONFIG.PROCESSING_LABEL);
  const skippedLabel = getOrCreateLabel_(CONFIG.PROCESSED_SKIPPED_LABEL);
  const errorLabel = getOrCreateLabel_(CONFIG.PROCESSED_ERROR_LABEL);
  const processedLabel = getOrCreateLabel_(CONFIG.PROCESSED_LABEL);

  // --- Build the Test Query ---
  const labelsQuery = `-label:${CONFIG.PROCESSED_LABEL} ` +
                      `-label:${CONFIG.PROCESSING_LABEL} ` +
                      `-label:${CONFIG.PROCESSED_SKIPPED_LABEL} ` +
                      `-label:${CONFIG.PROCESSED_ERROR_LABEL}`;
  const query = `label:${CONFIG.TEST_MODE_LABEL} ${labelsQuery}`;
  
  Logger.log('--- !!! TEST MODE ACTIVE !!! ---');
  Logger.log('Searching for ONE thread with query: %s', query);

  const threads = GmailApp.search(query, 0, 1); // Find only one
  if (!threads.length) {
    Logger.log('No threads found with the test label "%s".', CONFIG.TEST_MODE_LABEL);
    return;
  }

  const thread = threads[0];
  const me = Session.getActiveUser().getEmail();

  Logger.log('Found test thread: id=%s subject="%s"', thread.getId(), thread.getFirstMessageSubject());
  
  // --- Process the single thread ---
  thread.addLabel(processingLabel);
  thread.removeLabel(testLabel);

  try {
    const success = processThreadAndCreateNewDigest_(thread, me, storage);
    
    if (success) {
      Logger.log('   New digest created. Moving OLD thread %s to trash.', thread.getId());
      thread.moveToTrash();
      thread.removeLabel(processingLabel);
      thread.addLabel(processedLabel);
      Logger.log('   OLD thread %s successfully trashed and labeled.', thread.getId());
    } else {
      Logger.log('   Thread %s skipped (no attachments > %s), labeling as %s.', thread.getId(), humanSize_(CONFIG.SIZE_THRESHOLD_BYTES), CONFIG.PROCESSED_SKIPPED_LABEL);
      thread.removeLabel(processingLabel);
      thread.addLabel(skippedLabel);
    }
  } catch (e) {
    Logger.log('ERROR processing test thread %s: %s', thread.getId(), e.message);
    Logger.log('Stack: %s', e.stack);
    try {
      thread.removeLabel(processingLabel);
      thread.addLabel(errorLabel);
      Logger.log('   Thread %s labeled as %s.', thread.getId(), CONFIG.PROCESSED_ERROR_LABEL);
    } catch (eLabel) {
      Logger.log('Could not apply error label: %s', eLabel.message);
    }
  }
  
  Logger.log('runTest() finished');
}


/**
 * Draait het script in PRODUCTIE modus.
 * Verwerkt threads in batches gebaseerd op `GMAIL_QUERY_BASE`.
 */
function runProduction() {
  const startTime = Date.now();
  Logger.log('runProduction() start (Archiver v3.0)');
  const storage = getStorageProvider_(); // Haal de actieve storage provider op

  // SAFETY CHECK
  if (CONFIG.TEST_MODE) {
    Logger.log('ERROR: `TEST_MODE` is still set to `true` in USER_CONFIG_GENERAL.');
    Logger.log('Please set `TEST_MODE: false` to run in production.');
    Logger.log('Or, select the `runTest()` function to test a single thread.');
    return;
  }

  deleteContinuationTriggers_('runProduction'); // Triggers now point to this function

  // --- Build the Gmail Query ---
  const labelsQuery = `-label:${CONFIG.PROCESSED_LABEL} ` +
                      `-label:${CONFIG.PROCESSING_LABEL} ` +
                      `-label:${CONFIG.PROCESSED_SKIPPED_LABEL} ` +
                      `-label:${CONFIG.PROCESSED_ERROR_LABEL}`;
  const sizeQuery = `larger:${CONFIG.MIN_ATTACHMENT_SIZE_KB}k`;
  const query = `${CONFIG.GMAIL_QUERY_BASE} ${sizeQuery} ${labelsQuery}`;
  // --- End Query Build ---

  const threads = GmailApp.search(query, 0, CONFIG.MAX_THREADS_PER_RUN);
  Logger.log('Found %s threads (query: %s)', threads.length, query);
  if (!threads.length) {
    Logger.log('Nothing to do, all batches complete.');
    return;
  }

  // Get label objects
  const processedLabel = getOrCreateLabel_(CONFIG.PROCESSED_LABEL);
  const processingLabel = getOrCreateLabel_(CONFIG.PROCESSING_LABEL);
  const skippedLabel = getOrCreateLabel_(CONFIG.PROCESSED_SKIPPED_LABEL);
  const errorLabel = getOrCreateLabel_(CONFIG.PROCESSED_ERROR_LABEL);
  
  let needToContinue = false;
  let hitRateLimit = false;
  const me = Session.getActiveUser().getEmail();

  // Process each thread
  threads.forEach(thread => {
    const elapsedMinutes = (Date.now() - startTime) / 60000;
    if (hitRateLimit || elapsedMinutes >= CONFIG.EXECUTION_TIME_LIMIT_MINUTES) {
      if (!hitRateLimit) Logger.log('Time limit (%s min) reached. Pausing.', CONFIG.EXECUTION_TIME_LIMIT_MINUTES);
      needToContinue = true;
      return;
    }

    if (thread.getLabels().some(l => l.getName() === CONFIG.PROCESSING_LABEL)) {
      Logger.log('Thread %s is already being processed, skipping.', thread.getId());
      return;
    }
        
    thread.addLabel(processingLabel);
    
    try {
      const success = processThreadAndCreateNewDigest_(thread, me, storage);
      
      if (success) {
        // SUCCESS: Move the *old* thread to the trash and label *it*
        Logger.log('   New digest created. Moving OLD thread %s to trash.', thread.getId());
        thread.moveToTrash();
        thread.removeLabel(processingLabel);
        thread.addLabel(processedLabel); // Apply to OLD thread
        Logger.log('   OLD thread %s successfully trashed and labeled.', thread.getId());
      } else {
        // SKIPPED: No relevant attachments were found
        Logger.log('   Thread %s skipped (no attachments > %s), labeling as %s.', thread.getId(), humanSize_(CONFIG.SIZE_THRESHOLD_BYTES), CONFIG.PROCESSED_SKIPPED_LABEL);
        thread.removeLabel(processingLabel);
        thread.addLabel(skippedLabel);
      }
      
      Utilities.sleep(CONFIG.SLEEP_BETWEEN_THREADS_MS);

    } catch (e) {
      // ERROR HANDLING
      Logger.log('ERROR processing thread %s: %s', thread.getId(), e.message);
      Logger.log('Stack: %s', e.stack);

      // --- FIX V3.1: Verbeterde Foutafhandeling ---

      // VANG DAGELIJKSE QUOTA-FOUT OP (e-mail verzenden)
      if (e.message && e.message.includes('Service invoked too many times')) {
        Logger.log('   Gmail DAG QUOTA (email) bereikt. Stoppen van deze batch.');
        Logger.log('   Thread *blijft* "Processing" om morgen opnieuw te proberen.');
        hitRateLimit = true; // Stop deze batch
        needToContinue = true; // Plan een nieuwe batch (voor later)
        // BELANGRIJK: Verwijder het processingLabel NIET.
      
      } else if (e.message && e.message.includes('User-rate limit exceeded')) { // SNELHEIDS-limiet
        Logger.log('   Gmail "rate limit" (snelheid) gedetecteerd. Stoppen van deze batch.');
        hitRateLimit = true;
        needToContinue = true;
        // BELANGRIJK: Verwijder het processingLabel NIET.

      } else if (e.message.includes('Could not find new digest') || 
                 e.message.includes('Upload failed') ||
                 e.message.includes('share failed')) // Algemene term voor opslagfouten
      {
        Logger.log('   This is a critical error. Labeling thread as %s.', CONFIG.PROCESSED_ERROR_LABEL);
        thread.removeLabel(processingLabel);
        thread.addLabel(errorLabel);
      } else {
        // Dit is een onbekende/tijdelijke fout. Reset de thread.
        Logger.log('   Temporary/Unknown error. Resetting thread (removing processing label).');
        thread.removeLabel(processingLabel);
      }
      // --- EINDE FIX V3.1 ---
    }
  });
  
  // --- HANDLE NEXT BATCH ---
  if (needToContinue || (threads.length === CONFIG.MAX_THREADS_PER_RUN)) {
    const waitMinutes = hitRateLimit ? 15 : 5;
    Logger.log('More work to do, scheduling new trigger in %s minutes.', waitMinutes);
    createContinuationTrigger_('runProduction', waitMinutes);
  } else {
    Logger.log('Run complete, all items in this batch processed.');
  }

  Logger.log('runProduction() finished');
}

/**
 * Haalt de actieve storage provider op basis van de configuratie.
 * @returns {object} Het storage provider object (bv. NextcloudProvider).
 * @private
 */
function getStorageProvider_() {
  switch (ACTIVE_STORAGE_PROVIDER) {
    case 'Nextcloud':
      return NextcloudProvider;
    case 'GoogleDrive':
      return GoogleDriveProvider;
    default:
      throw new Error(`Unknown ACTIVE_STORAGE_PROVIDER: "${ACTIVE_STORAGE_PROVIDER}". Check Config.gs.`);
  }
}

/**
 * Hoofdlogica: verzamelt bijlagen, bouwt een *nieuwe* mail,
 * en archiveert/labelt die nieuwe mail.
 * @param {GmailApp.Thread} thread De te verwerken Gmail-thread.
 * @param {string} me E-mailadres van de gebruiker.
 * @param {object} storage De actieve storage provider (bv. NextcloudProvider).
 * @returns {boolean} `true` bij succes, `false` indien overgeslagen.
 * @private
 */
function processThreadAndCreateNewDigest_(thread, me, storage) {
  Logger.log('--- THREAD start --- id=%s subject="%s"', thread.getId(), thread.getFirstMessageSubject());
  const messages = thread.getMessages();
  
  const allUploaded = [];     // Lijst van alle geüploade bestanden
  const messagesToDigest = []; // Array om info vast te houden voor het bouwen van de digest
  const threadLabels = thread.getLabels().map(l => l.getName()).filter(name => name !== CONFIG.PROCESSING_LABEL).sort();

  // --- STAP 1: Loop EENMAAL door alle berichten ---
  messages.forEach((msg, idx) => {
    // 1. Haal info op (headers, body) voor *elk* bericht
    const info = extractMessageInfo_(msg);
    messagesToDigest.push(info); // Sla info op om later de digest te bouwen

    // 2. Controleer op bijlagen in dit bericht
    if (msg.isInTrash() || msg.getFrom().includes(me)) {
      return;
    }
    const atts = msg.getAttachments({ includeInlineImages: CONFIG.INCLUDE_INLINE_IMAGES, includeAttachments: true });
    if (atts.length === 0) return;

    // 3. Filter bijlagen op grootte
    const bigAtts = atts.filter(b => b.getSize() >= CONFIG.SIZE_THRESHOLD_BYTES);
    if (bigAtts.length === 0) return;

    // 4. Upload relevante bijlagen
    for (const blob of bigAtts) {
      const bytes = blob.getBytes();
      const hash = sha256Hex_(bytes);
      const originalName = blob.getName() || 'attachment.bin';
      const safeName = sanitizeFilename_(originalName);
      const fileName = `${info.messageIdGmail}__${hash}__${safeName}`;
      
      // Gebruik de storage provider
      Logger.log('     UPLOAD -> %s (%s)', fileName, ACTIVE_STORAGE_PROVIDER);
      const uploadResult = storage.uploadFile(fileName, blob, info);

      let linkToShow;
      try {
        linkToShow = storage.createShareLink(fileName, uploadResult);
      } catch (e) {
        Logger.log('     Share link failed, falling back to UI link: %s', e.message);
        linkToShow = storage.createUiLink(fileName, uploadResult);
      }
      
      allUploaded.push({
        name: originalName,
        size: bytes.length,
        link: linkToShow
      });
      Utilities.sleep(CONFIG.SLEEP_AFTER_UPLOAD_MS);
    }
  });

  // Als er geen bijlagen zijn gevonden die aan de drempel voldoen
  if (allUploaded.length === 0) {
    Logger.log('--- THREAD skip (no attachments passed filter) ---');
    return false; // Return 'false' (overgeslagen)
  }

  // --- STAP 2: Bouw de HTML/Tekst body voor de NIEUWE mail ---
  const htmlBodyParts = [];
  const textBodyParts = [];
  
  const linkHtml = allUploaded.map(u => 
    `<li><a href="${u.link}">${escapeHtml_(u.name)}</a> (${humanSize_(u.size)})</li>`
  ).join('');
  htmlBodyParts.push(`
    <p><strong>Uploaded attachments (${allUploaded.length} files):</strong></p>
    <ul>${linkHtml}</ul>
    <hr>
    <p><strong>Original thread content below:</strong></p>
  `);
  
  const linkText = allUploaded.map(u => 
    `- ${u.name} (${humanSize_(u.size)})\n  Link: ${u.link}`
  ).join('\n');
  textBodyParts.push(`Uploaded attachments (${allUploaded.length} files):\n${linkText}\n\n---\nOriginal thread content below:\n---\n`);

  // Loop nu door de *opgeslagen info* (veel sneller)
  messagesToDigest.forEach((info, idx) => {
    const labels = threadLabels.join(', ');
    
    const quotedHtml = info.htmlBody || escapeHtml_(info.plainBody);
    htmlBodyParts.push(`
      <div style="border:1px solid #ccc;padding:10px;margin-bottom:10px;border-radius:8px;">
        <p><strong>Message ${idx + 1}</strong><br>
        <strong>From:</strong> ${escapeHtml_(info.from)}<br>
        <strong>To:</strong> ${escapeHtml_(info.to)}<br>
        ${info.cc ? `<strong>CC:</strong> ${escapeHtml_(info.cc)}<br>` : ''}
        <strong>Date:</strong> ${escapeHtml_(String(info.date))}<br>
        <strong>Subject:</strong> ${escapeHtml_(info.subject)}<br>
        <strong>Original Thread Labels:</strong> ${escapeHtml_(labels)}</p>
        <hr>
        <blockquote style="border-left:3px solid #eee;padding-left:12px;margin-left:5px;">
          ${quotedHtml}
        </blockquote>
      </div>
    `);

    textBodyParts.push(
      `== Message ${idx + 1} ==\n` +
      `From: ${info.from}\n` +
      `To: ${info.to}\n` +
      (info.cc ? `CC: ${info.cc}\n` : '') +
      `Date: ${String(info.date)}\n` +
      `Subject: ${info.subject}\n` +
      `Original Thread Labels: ${labels}\n\n` +
      `${info.plainBody}\n\n`
    );
  });
  
  const finalHtmlBody = htmlBodyParts.join('');
  const finalTextBody = textBodyParts.join('---\n');
  const finalSubject = `${CONFIG.DIGEST_SUBJECT_PREFIX} ${thread.getFirstMessageSubject()}`;

  // --- STAP 3: Stuur de nieuwe mail (robuuste methode) ---
  try {
    Logger.log('   Creating new draft...');
    const draft = GmailApp.createDraft(me, finalSubject, finalTextBody, {
      htmlBody: finalHtmlBody,
      name: 'Gmail Archiver Script'
    });

    const message = draft.send();
    Logger.log('   New digest email sent (Message ID: %s)', message.getId());
    
    const newDigestThread = message.getThread();
    if (newDigestThread) {
      Logger.log('   New digest thread found (id: %s). Archiving and applying labels...', newDigestThread.getId());
      
      // --- NIEUWE FIX (V3.2): Pas de oude labels toe ---
      // Systeemlabels die we niet handmatig kunnen/willen toevoegen
      const systemLabelsToIgnore = [
        'INBOX', 'UNREAD', 'SENT', 'DRAFT', 'TRASH', 'SPAM',
        CONFIG.PROCESSING_LABEL, CONFIG.PROCESSED_LABEL, 
        CONFIG.PROCESSED_ERROR_LABEL, CONFIG.PROCESSED_SKIPPED_LABEL,
        CONFIG.TEST_MODE_LABEL
      ];
      
      threadLabels.forEach(labelName => {
        // Filter de script-labels en systeem-labels eruit
        // We controleren zowel de exacte naam als de hoofdletterversie voor de zekerheid
        if (systemLabelsToIgnore.includes(labelName) || 
            systemLabelsToIgnore.includes(labelName.toUpperCase())) {
          return; // Sla dit label over
        }
        
        try {
          // Haal het label-object op (of maak het aan) en voeg het toe
          const label = getOrCreateLabel_(labelName);
          if (label) {
            newDigestThread.addLabel(label);
          }
        } catch (e) {
          // Log een waarschuwing maar stop het script niet
          Logger.log('     WAARSCHUWING: Kon label "%s" niet toevoegen aan nieuwe thread: %s', labelName, e.message);
        }
      });
      // --- EINDE FIX ---

      newDigestThread.moveToArchive();
      Logger.log('   New digest thread successfully archived and labeled.');
    } else {
      Logger.log('   CRITICAL: Could not get thread from sent message.');
      throw new Error('Could not get thread from sent message. Old thread will not be trashed.');
    }
    
    return true; // Success

  } catch (e) {
    Logger.log('   ERROR sending/finding new digest email: %s', e.message);
    throw new Error('Sending/finding new digest failed: ' + e.message);
  }
}


// ===================================================================================
// HELPER FUNCTIONS (Gmail)
// ===================================================================================

/**
 * Haalt een Gmail-label op naam op, of maakt het aan als het niet bestaat.
 * @param {string} name De naam van het label.
 * @returns {GmailApp.Label} Het label-object.
 * @private
 */
function getOrCreateLabel_(name) {
  if (!name) {
    Logger.log('getOrCreateLabel_ called with empty name, skipping.');
    return null;
  }
  let label = GmailApp.getUserLabelByName(name);
  if (!label) {
    Logger.log('Label "%s" does not exist, creating it.', name);
    label = GmailApp.createLabel(name);
  }
  return label;
}

/**
 * Extraheert belangrijke info uit een GmailMessage-object.
 * @param {GmailApp.Message} msg Het berichtobject.
 * @returns {object} Een info-object.
 * @private
 */
function extractMessageInfo_(msg) {
  const rfcMsgId = msg.getHeader('Message-Id') || '';
  return {
    threadId: msg.getThread().getId(),
    messageIdGmail: msg.getId(),
    messageIdRfc822: rfcMsgId.replace(/[<>]/g, ''),
    from: msg.getFrom(),
    to: msg.getTo(),
    cc: msg.getCc() || '',
    date: msg.getDate(),
    subject: msg.getSubject(),
    plainBody: msg.getPlainBody(),
    htmlBody: msg.getBody()
  };
}

/**
 * Haalt een map (id->naam) van alle Gmail-labels op, met 6 uur cache.
 * @returns {object} De label-map {id: name}.
 * @private
 */
function getLabelIdNameMap_() {
  const cache = CacheService.getScriptCache();
  const CACHE_KEY = 'GMAIL_LABEL_MAP_V3'; // v3 voor modulaire versie
  let mapJson = cache.get(CACHE_KEY);
  if (mapJson) return JSON.parse(mapJson);
  
  Logger.log('Label map cache is empty, refilling via API...');
  const map = {};
  try {
    const res = Gmail.Users.Labels.list('me');
    if (res.labels) res.labels.forEach(l => { map[l.id] = l.name; });
  } catch (e) {
    Logger.log('Could not fetch labels via Gmail API: %s', e.message);
  }
  cache.put(CACHE_KEY, JSON.stringify(map), 21600); // 6-hour cache
  return map;
}

// ===================================================================================
// UTILITIES (Algemeen)
// ===================================================================================

/**
 * Berekent een SHA256-hash van bytes.
 * @param {byte[]} bytes De bytes van het bestand.
 * @returns {string} De 64-karakter hex hash.
 * @private
 */
function sha256Hex_(bytes) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  return raw.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

/**
 * Maakt een bestandsnaam veilig voor bestandssystemen.
 * @param {string} name De originele bestandsnaam.
 * @returns {string} De "schone" bestandsnaam.
 * @private
 */
function sanitizeFilename_(name) {
  if (!name) return 'unknown_file';
  return name.replace(/[/\\?%*:|"<>]/g, '_').replace(/\s+/g, ' ').trim();
}

/**
 * Converteert bytes naar een leesbaar formaat (KB, MB, etc.).
 * @param {number} n Het aantal bytes.
 * @returns {string} De leesbare grootte.
 * @private
 */
function humanSize_(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
}

/**
 * Escapet HTML-speciale tekens.
 * @param {string} s De te escapen string.
 * @returns {string} De ge-escapete string.
 * @private
 */
function escapeHtml_(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/**
 * Kort HTML of tekst netjes in.
 * @param {string} html De string om in te korten.
 * @param {number} maxLen De maximale lengte.
 * @returns {string} De ingekorte string.
 * @private
 */
function trimHtml_(html, maxLen) {
  if (!html) return '';
  const s = String(html);
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

// ===================================================================================
// TRIGGER MANAGEMENT (voor batches)
// ===================================================================================

/**
 * Maakt een nieuwe trigger om het script later opnieuw te starten.
 * @param {string} handlerFunction De naam van de functie (bv. 'runProduction').
 * @param {number} waitMinutes Het aantal minuten om te wachten.
 * @private
 */
function createContinuationTrigger_(handlerFunction, waitMinutes) {
  deleteContinuationTriggers_(handlerFunction); // Verwijder eerst oude
  const waitMs = (waitMinutes || 5) * 60 * 1000;
  ScriptApp.newTrigger(handlerFunction)
    .timeBased()
    .after(waitMs)
    .create();
  Logger.log('New continuation trigger created for %s (waiting %s min).', handlerFunction, waitMinutes);
}

/**
 * Verwijdert oude triggers om de "too many triggers" fout te voorkomen.
 * @param {string} handlerFunction De naam van de functie om triggers voor te wissen.
 * @private
 */
function deleteContinuationTriggers_(handlerFunction) {
  if (!handlerFunction) return;
  const triggers = ScriptApp.getProjectTriggers();
  let deletedCount = 0;
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === handlerFunction) {
      ScriptApp.deleteTrigger(trigger);
      deletedCount++;
    }
  }
  if (deletedCount > 0) {
    Logger.log('%s old "%s" trigger(s) deleted.', deletedCount, handlerFunction);
  }
}


/**
 * Stelt de hoofd-trigger (elk uur) in voor `runProduction`.
 * Draai deze functie eenmalig vanuit de editor.
 */
function setupTriggerHourly() {
  deleteContinuationTriggers_('runProduction'); // Verwijder actieve batch-triggers
  
  // Verwijder bestaande 'runProduction' uur-triggers
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'runProduction') {
      ScriptApp.deleteTrigger(trigger);
      Logger.log('Old hourly "runProduction" trigger deleted.');
    }
  }
  
  // Maak nieuwe trigger
  ScriptApp.newTrigger('runProduction').timeBased().everyHours(1).create();
  Logger.log('New hourly "runProduction" trigger created.');
}

// ===================================================================================
// DEBUG HELPERS (optioneel)
// ===================================================================================

/**
 * Test je GMAIL_QUERY en kijk welke threads het vindt.
 * Draait *exact dezelfde* query-logica als `runProduction` of `runTest`.
 */
function testQuery() {
  let query = '';
  
  const labelsQuery = `-label:${CONFIG.PROCESSED_LABEL} ` +
                      `-label:${CONFIG.PROCESSING_LABEL} ` +
                      `-label:${CONFIG.PROCESSED_SKIPPED_LABEL} ` +
                      `-label:${CONFIG.PROCESSED_ERROR_LABEL}`;
  
  if (CONFIG.TEST_MODE) {
    query = `label:${CONFIG.TEST_MODE_LABEL} ${labelsQuery}`;
    Logger.log('--- TEST MODE QUERY ---');
  } else {
    const sizeQuery = `larger:${CONFIG.MIN_ATTACHMENT_SIZE_KB}k`;
    query = `${CONFIG.GMAIL_QUERY_BASE} ${sizeQuery} ${labelsQuery}`;
    Logger.log('--- PRODUCTION MODE QUERY ---');
  }
  // --- End Query Build ---

  const threads = GmailApp.search(query, 0, 20);
  Logger.log('Query: %s', query);
  Logger.log('Found %s threads (max 20):', threads.length);
  threads.forEach((t, i) => {
    const m = t.getMessages();
    Logger.log('%s) threadId=%s, subject=%s, msgs=%s, labels=%s', i + 1, t.getId(), t.getFirstMessageSubject(), m.length, t.getLabels().map(l=>l.getName()).join(','));
  });
}

/**
 * Test de verbinding en upload-credentials van de *actieve* storage provider.
 */
function testStorageProvider() {
  Logger.log('Testing storage provider: %s', ACTIVE_STORAGE_PROVIDER);
  try {
    const storage = getStorageProvider_();
    const fileName = 'TEST__' + Date.now() + '__hello.txt';
    const blob = Utilities.newBlob('hello', 'text/plain', 'hello.txt');
    
    const uploadResult = storage.uploadFile(fileName, blob, { messageIdGmail: 'test-id' });
    Logger.log('Test upload OK. Result/ID: %s', uploadResult);
    
    const uiLink = storage.createUiLink(fileName, uploadResult);
    Logger.log('Test link (UI): %s', uiLink);
  } catch (e) {
    Logger.log('Test storage provider FAILED: %s', e.message);
  }
}
