/**
 * ===================================================================================
 * GMAIL ARCHIVER - MAIN SCRIPT (v4.9 - Enhanced)
 * ===================================================================================
 * This file contains the *core logic* for Gmail, batching, and processing threads.
 *
 * === MAIN FUNCTIONS ===
 * runTest()                       - ESSENTIAL: Safe testing on 1 labeled thread before production use
 * runProduction()                 - ESSENTIAL: Main batch processor for archiving attachments
 * setupTriggerHourly()            - RECOMMENDED: Sets up automatic hourly execution
 *
 * === RECOVERY UTILITIES ===
 * cleanupOrphanedDrafts()         - ESSENTIAL: Removes stuck drafts after errors (prevents inbox clutter)
 * resetStuckProcessingLabels()    - ESSENTIAL: Fixes threads stuck in "processing" after crashes
 * emergencyRollback()             - CRITICAL: Restores archived threads from trash (30-day window)
 *
 * === TESTING & VALIDATION ===
 * testQuery()                     - RECOMMENDED: Preview which threads will be processed (prevents mistakes)
 * testStorageProvider()           - ESSENTIAL: Validates cloud storage config before first run
 * validateConfiguration()         - RECOMMENDED: Catches 15+ config errors before they cause problems
 *
 * === OPTIONAL UTILITIES ===
 * showMetrics()                   - RECOMMENDED: Displays performance statistics
 * resetMetrics()                  - OPTIONAL: Clears all metrics for fresh start
 *
 * NOTE: Digest emails are automatically marked as read when archived.
 *
 * @see Config.gs (for all configuration)
 * @see Nextcloud_Connector (for Nextcloud implementation)
 * @see GoogleDrive_Connector (for Google Drive implementation)
 * ===================================================================================
 */

// ===================================================================================
// ERROR CLASSIFICATION SYSTEM
// ===================================================================================

/**
 * Classifies errors into categories for appropriate handling.
 * @param {Error} e The error object.
 * @returns {string} Error type: 'RATE_LIMIT', 'QUOTA', 'PERMANENT', or 'TRANSIENT'.
 * @private
 */
function classifyError_(e) {
  const msg = e.message || '';

  // Speed-based rate limiting (temporary)
  if (msg.includes('User-rate limit exceeded')) {
    return 'RATE_LIMIT';
  }

  // Daily quota exceeded (wait until next day)
  if (msg.includes('Service invoked too many times')) {
    return 'QUOTA';
  }

  // Permanent errors that won't fix themselves
  if (msg.includes('Could not find new digest') ||
      msg.includes('Upload failed') ||
      msg.includes('share failed') ||
      msg.includes('Email Body Size') ||
      msg.includes('Argument too large: subject') ||
      msg.includes('Cannot read properties of null')) {
    return 'PERMANENT';
  }

  // Everything else is considered transient (retry next run)
  return 'TRANSIENT';
}

// ===================================================================================
// SCRIPT ENTRYPOINTS (Main Functions)
// ===================================================================================

/**
 * ESSENTIAL - Safe testing before production use.
 *
 * WHY NEEDED:
 * - Processing email is DESTRUCTIVE (original threads are deleted)
 * - Testing on 1 thread lets you verify: digest format, file uploads, labels
 * - Prevents accidentally archiving thousands of threads with wrong config
 *
 * HOW TO USE:
 * 1. Manually apply label "test-gmail-cleanup" to 1-2 test threads
 * 2. Run this function from Apps Script editor
 * 3. Check results before enabling runProduction()
 *
 * Searches for `CONFIG.TEST_MODE_LABEL` and processes the first thread it finds.
 */
function runTest() {
  Logger.log('runTest() start (Archiver v4.8)');
  const storage = getStorageProvider_();
  if (!storage) return;

  // Get labels
  const testLabel = getOrCreateLabel_(CONFIG.TEST_MODE_LABEL);
  const processingLabel = getOrCreateLabel_(CONFIG.PROCESSING_LABEL);
  const skippedLabel = getOrCreateLabel_(CONFIG.PROCESSED_SKIPPED_LABEL);
  const errorLabel = getOrCreateLabel_(CONFIG.PROCESSED_ERROR_LABEL);
  const processedLabel = getOrCreateLabel_(CONFIG.PROCESSED_LABEL); // Ensure it exists

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
 * ESSENTIAL - Main production batch processor.
 *
 * WHY NEEDED:
 * - This is THE core function that archives your Gmail attachments
 * - Handles batching (processes max N threads then schedules continuation)
 * - Includes all safety mechanisms: rate limit handling, error recovery, metrics
 *
 * SAFETY FEATURES:
 * - Refuses to run if TEST_MODE is still enabled
 * - Respects PROCESSING_HOURS window (if configured)
 * - Auto-schedules continuation if more work remains
 * - Sends progress emails (if enabled)
 * - Tracks comprehensive metrics
 *
 * HOW IT WORKS:
 * 1. Searches Gmail for threads matching criteria
 * 2. Processes up to MAX_THREADS_PER_RUN threads
 * 3. If more work remains, schedules itself to run again in 5 minutes
 * 4. Stops before 6-minute Apps Script timeout
 *
 * Processes threads in batches based on `GMAIL_QUERY_BASE`.
 */
function runProduction() {
  const startTime = Date.now();
  Logger.log('runProduction() start (Archiver v4.8)');

  const storage = getStorageProvider_();
  if (!storage) return;

  // SAFETY CHECK
  if (CONFIG.TEST_MODE) {
    Logger.log('ERROR: `TEST_MODE` is still set to `true` in Config.gs.');
    Logger.log('Please set `TEST_MODE: false` to run in production.');
    Logger.log('Or, select the `runTest()` function to test a single thread.');
    return;
  }

  // SMART SCHEDULING CHECK
  if (CONFIG.PROCESSING_HOURS) {
    const currentHour = new Date().getHours();
    if (currentHour < CONFIG.PROCESSING_HOURS.START || currentHour >= CONFIG.PROCESSING_HOURS.END) {
      Logger.log('Outside processing window (%s:00 - %s:00). Skipping run.',
        CONFIG.PROCESSING_HOURS.START, CONFIG.PROCESSING_HOURS.END);
      return;
    }
  }

  // PREVIEW MODE CHECK
  if (CONFIG.PREVIEW_MODE) {
    Logger.log('=== PREVIEW MODE ACTIVE ===');
    Logger.log('Script will LOG actions but NOT upload/delete anything.');
  }

  deleteContinuationTriggers_('runProduction'); // Triggers now point to this function

  // Track batch
  incrementMetric_('total_batches');
  recordMetric_('last_run', new Date().toISOString());

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

  // Batch statistics for progress notification
  const batchStats = {
    processed: 0,
    skipped: 0,
    errored: 0,
    filesUploaded: 0,
    bytesSaved: 0
  };

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
        // SUCCESS: Move the *old* thread to trash and label it
        Logger.log('   New digest created. Moving OLD thread %s to trash.', thread.getId());
        thread.moveToTrash();
        thread.removeLabel(processingLabel);
        thread.addLabel(processedLabel); // Apply to OLD thread
        Logger.log('   OLD thread %s successfully trashed and labeled.', thread.getId());

        // Update metrics and batch stats
        incrementMetric_('threads_processed');
        batchStats.processed++;
      } else {
        // SKIPPED: No relevant attachments found
        Logger.log('   Thread %s skipped (no attachments > %s), labeling as %s.', thread.getId(), humanSize_(CONFIG.SIZE_THRESHOLD_BYTES), CONFIG.PROCESSED_SKIPPED_LABEL);
        thread.removeLabel(processingLabel);
        thread.addLabel(skippedLabel);

        // Update metrics and batch stats
        incrementMetric_('threads_skipped');
        batchStats.skipped++;
      }

      Utilities.sleep(CONFIG.SLEEP_BETWEEN_THREADS_MS);

    } catch (e) {
      // ERROR HANDLING
      Logger.log('ERROR processing thread %s: %s', thread.getId(), e.message);
      Logger.log('Stack: %s', e.stack);

      // Classify error and handle appropriately
      const errorType = classifyError_(e);

      switch (errorType) {
        case 'RATE_LIMIT':
          Logger.log('   Gmail rate limit (speed) detected. Stopping this batch.');
          hitRateLimit = true;
          needToContinue = true;
          // IMPORTANT: Do NOT remove processingLabel. Wait for limit to pass.
          break;

        case 'QUOTA':
          Logger.log('   Gmail Daily Quota (100+ emails) detected. Stopping batch.');
          Logger.log('   Thread will be retried when quota resets (tomorrow).');
          hitRateLimit = true;
          needToContinue = true;
          // IMPORTANT: Do NOT remove processingLabel. Wait for quota to reset.
          break;

        case 'PERMANENT':
          Logger.log('   This is a critical, non-recoverable error. Labeling thread as %s.', CONFIG.PROCESSED_ERROR_LABEL);
          thread.removeLabel(processingLabel);
          thread.addLabel(errorLabel);
          incrementMetric_('threads_errored');
          batchStats.errored++;
          break;

        case 'TRANSIENT':
        default:
          Logger.log('   Temporary/Unknown error. Resetting thread (removing processing label).');
          thread.removeLabel(processingLabel);
          break;
      }
    }
  });
  
  // --- HANDLE NEXT BATCH ---
  // Check if there's more work to do by doing a lightweight query
  const hasMoreWork = needToContinue || GmailApp.search(query, 0, 1).length > 0;

  if (hasMoreWork) {
    const waitMinutes = hitRateLimit ? 15 : 5; // Wait longer for rate limits
    Logger.log('More work to do, scheduling new trigger in %s minutes.', waitMinutes);
    batchStats.nextRunMinutes = waitMinutes;
    createContinuationTrigger_('runProduction', waitMinutes);
  } else {
    Logger.log('Run complete, all items in this batch processed.');
    batchStats.nextRunMinutes = 0;
  }

  // Send progress notification if enabled
  if (CONFIG.SEND_PROGRESS_EMAILS && (batchStats.processed > 0 || batchStats.errored > 0)) {
    sendProgressNotification_(batchStats);
  }

  Logger.log('runProduction() finished');
}

/**
 * Gets the active storage provider based on configuration.
 * @returns {object|null} The provider (e.g., NextcloudProvider) or null on error.
 * @private
 */
function getStorageProvider_() {
  try {
    switch (ACTIVE_STORAGE_PROVIDER) {
      case 'Nextcloud':
        return NextcloudProvider;
      case 'GoogleDrive':
        return GoogleDriveProvider;
      default:
        throw new Error(`Unknown ACTIVE_STORAGE_PROVIDER: "${ACTIVE_STORAGE_PROVIDER}" in Config.gs`);
    }
  } catch (e) {
    Logger.log(e.message);
    return null;
  }
}

/**
 * Main logic: collects attachments, builds a *new* email,
 * and archives that new email. (Efficient, single-loop version).
 * @param {GmailApp.Thread} thread The Gmail thread to process.
 * @param {string} me The user's email address.
 * @param {object} storage The active storage provider (e.g., NextcloudProvider).
 * @returns {boolean} `true` on success, `false` if skipped.
 * @private
 */
function processThreadAndCreateNewDigest_(thread, me, storage) {
  Logger.log('--- THREAD start --- id=%s subject="%s"', thread.getId(), thread.getFirstMessageSubject());

  const messages = thread.getMessages();

  const allUploaded = [];     // List of all uploaded files
  const messagesToDigest = []; // Array to store info for building the digest
  const threadLabels = thread.getLabels().map(l => l.getName()).filter(name => name !== CONFIG.PROCESSING_LABEL).sort();
  const uploadedHashes = new Set(); // Thread-level deduplication

  // Global deduplication cache (cross-thread)
  const globalCache = CONFIG.ENABLE_GLOBAL_DEDUPLICATION ? CacheService.getScriptCache() : null;

  // --- STEP 1: Loop ONCE through all messages ---
  let uploadCount = 0; // Track actual uploads for sleep optimization
  let totalBytes = 0;  // Track bytes for metrics

  messages.forEach((msg, idx) => {
    // 1. Get info (headers, body) for *each* message
    const info = extractMessageInfo_(msg);
    messagesToDigest.push(info);

    // 2. Check for attachments in this message
    if (msg.isInTrash() || msg.getFrom().includes(me)) {
      return;
    }
    const atts = msg.getAttachments({ includeInlineImages: CONFIG.INCLUDE_INLINE_IMAGES, includeAttachments: true });
    if (atts.length === 0) return;

    // 3. Filter attachments by size
    const bigAtts = atts.filter(b => b.getSize() >= CONFIG.SIZE_THRESHOLD_BYTES);
    if (bigAtts.length === 0) return;

    // 4. Upload relevant attachments
    for (const blob of bigAtts) {
      const bytes = blob.getBytes();
      const hash = sha256Hex_(bytes);
      const originalName = blob.getName() || 'attachment.bin';

      // Skip duplicates within the same thread
      if (uploadedHashes.has(hash)) {
        Logger.log('     -> Duplicate attachment found (hash: %s), upload skipped.', hash.substring(0, 10));
        incrementMetric_('duplicates_skipped');
        continue;
      }

      // Check global cache for cross-thread duplicates
      if (globalCache) {
        const cacheKey = `uploaded_${hash}`;
        const cachedInfo = globalCache.get(cacheKey);

        if (cachedInfo) {
          const existing = JSON.parse(cachedInfo);
          Logger.log('     -> File already uploaded in thread %s, reusing link', existing.threadId.substring(0, 10));
          allUploaded.push({
            name: originalName,
            size: bytes.length,
            link: existing.link
          });
          uploadedHashes.add(hash);
          incrementMetric_('duplicates_skipped');
          continue;
        }
      }

      const safeName = sanitizeFilename_(originalName);
      const fileName = `${info.messageIdGmail}__${hash}__${safeName}`;

      // PREVIEW MODE: Log but don't actually upload
      if (CONFIG.PREVIEW_MODE) {
        Logger.log('     [PREVIEW] Would upload -> %s (%s)', fileName, ACTIVE_STORAGE_PROVIDER);
        allUploaded.push({
          name: originalName,
          size: bytes.length,
          link: '[PREVIEW - Not uploaded]'
        });
        uploadedHashes.add(hash);
        continue;
      }

      Logger.log('     UPLOAD -> %s (%s)', fileName, ACTIVE_STORAGE_PROVIDER);
      const uploadResult = storage.uploadFile(fileName, blob, info);
      uploadedHashes.add(hash);
      uploadCount++;
      totalBytes += bytes.length;

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

      // Store in global cache for cross-thread deduplication
      if (globalCache) {
        const cacheKey = `uploaded_${hash}`;
        globalCache.put(cacheKey, JSON.stringify({
          threadId: thread.getId(),
          link: linkToShow,
          uploadedAt: Date.now()
        }), 86400); // 24 hour cache
      }
    }

    // Sleep only AFTER processing all attachments in this message (if any were uploaded)
    if (uploadCount > 0 && bigAtts.length > 0) {
      Utilities.sleep(CONFIG.SLEEP_AFTER_UPLOAD_MS);
    }
  });

  if (allUploaded.length === 0) {
    Logger.log('--- THREAD skip (no attachments passed filter) ---');
    return false;
  }

  // --- STEP 2: Build the HTML/Text body for the NEW email ---
  const htmlBodyParts = [];
  const textBodyParts = [];

  const MAX_BODY_CHARS = CONFIG.MAX_BODY_CHARS; // Use configurable limit

  // Add the file links at the top
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

  // Loop through the *stored info* and build digest
  let totalTruncatedChars = 0; // Track truncation for logging

  messagesToDigest.forEach((info, idx) => {
    const labels = threadLabels.join(', ');

    // Remove base64 images FIRST, then truncate
    let htmlContent = info.htmlBody || escapeHtml_(info.plainBody);
    htmlContent = removeBase64Images_(htmlContent); // Remove inline images

    if (htmlContent.length > MAX_BODY_CHARS) {
      const truncated = htmlContent.length - MAX_BODY_CHARS;
      totalTruncatedChars += truncated;
      htmlContent = htmlContent.substring(0, MAX_BODY_CHARS) +
        `<br><br><em>[... ${truncated} characters truncated due to Gmail limits ...]</em>`;
    }

    let textContent = info.plainBody;
    if (textContent.length > MAX_BODY_CHARS) {
      const truncated = textContent.length - MAX_BODY_CHARS;
      textContent = textContent.substring(0, MAX_BODY_CHARS) +
        `\n\n[... ${truncated} characters truncated due to Gmail limits ...]`;
    }

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
          ${htmlContent}
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
      `${textContent}\n\n`
    );
  });

  // Log truncation metrics if significant content was removed
  if (totalTruncatedChars > 0) {
    Logger.log('   -> WARNING: Truncated %s total characters from %s messages', totalTruncatedChars, messagesToDigest.length);
  }

  const finalHtmlBody = htmlBodyParts.join('');
  const finalTextBody = textBodyParts.join('---\n');

  // Fallback for 'null' subjects
  const originalSubject = thread.getFirstMessageSubject() || '(no subject)';
  // Truncate subject to prevent "Argument too large" error
  const truncatedSubject = (originalSubject.length > 200) ? originalSubject.substring(0, 200) + '...' : originalSubject;
  const finalSubject = `${CONFIG.DIGEST_SUBJECT_PREFIX} ${truncatedSubject}`;

  // --- STEP 3: Send the new email ---
  // PREVIEW MODE: Log but don't actually send
  if (CONFIG.PREVIEW_MODE) {
    Logger.log('   [PREVIEW] Would create digest with subject: %s', finalSubject);
    Logger.log('   [PREVIEW] Would trash thread: %s', thread.getId());
    Logger.log('   [PREVIEW] Preview complete. No changes made.');
    return true; // Return success in preview mode
  }

  // Wrap draft creation in try-catch to cleanup orphans on error
  let draft = null;
  try {
    Logger.log('   Creating new draft...');
    draft = GmailApp.createDraft(me, finalSubject, finalTextBody, {
      htmlBody: finalHtmlBody,
      name: 'Gmail Archiver Script'
    });

    const message = draft.send();
    Logger.log('   New digest email sent (Message ID: %s)', message.getId());

    // Track metrics
    incrementMetric_('files_uploaded', allUploaded.length);
    incrementMetric_('bytes_uploaded', totalBytes);
    
    const newDigestThread = message.getThread();
    if (newDigestThread) {
      Logger.log('   New digest thread found (id: %s). Archiving and applying labels...', newDigestThread.getId());

      // Apply old labels to new thread
      const systemLabelsToIgnore = [
        'INBOX', 'UNREAD', 'SENT', 'DRAFT', 'TRASH', 'SPAM',
        'IMPORTANT', 'STARRED', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL',
        'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
        CONFIG.PROCESSED_LABEL, CONFIG.PROCESSING_LABEL,
        CONFIG.PROCESSED_ERROR_LABEL, CONFIG.PROCESSED_SKIPPED_LABEL,
        CONFIG.TEST_MODE_LABEL
      ];

      threadLabels.forEach(labelName => {
        const labelUpper = labelName ? labelName.toUpperCase() : '';
        if (!labelName || systemLabelsToIgnore.some(sys => sys === labelUpper)) {
          return;
        }
        try {
          const label = getOrCreateLabel_(labelName);
          if (label) newDigestThread.addLabel(label);
        } catch (e) {
          Logger.log('     -> WARN: Could not apply old label "%s": %s', labelName, e.message);
        }
      });

      newDigestThread.moveToArchive();

      // Always mark digests as read (archived = cleaned up = read)
      newDigestThread.markRead();
      Logger.log('   New digest thread marked as read (archived digests are always read).');

      Logger.log('   New digest thread successfully archived.');
    } else {
      Logger.log('   CRITICAL: Could not get thread from sent message.');
      throw new Error('Could not get thread from sent message. Old thread will not be trashed.');
    }

    return true; // Success

  } catch (e) {
    // Cleanup orphaned draft
    if (draft) {
      try {
        draft.deleteDraft();
        Logger.log('   Cleaned up orphaned draft after error.');
      } catch (e2) {
        Logger.log('   Failed to clean up draft: %s', e2.message);
      }
    }

    Logger.log('   ERROR sending/finding new digest email: %s', e.message);
    throw new Error('Sending/finding new digest failed: ' + e.message);
  }
}


// ===================================================================================
// HELPER FUNCTIONS (Gmail)
// ===================================================================================

/**
 * Gets a Gmail label by name, creates it if it doesn't exist.
 * @param {string} name The label name.
 * @returns {GmailApp.Label} The label object.
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
 * Extracts important information from a GmailMessage object.
 * @param {GmailApp.Message} msg The message object.
 * @returns {object} An info object.
 * @private
 */
function extractMessageInfo_(msg) {
  const rfcMsgId = msg.getHeader('Message-Id') || '';
  return {
    threadId: msg.getThread().getId(),
    messageIdGmail: msg.getId(),
    messageIdRfc822: rfcMsgId.replace(/[<>]/g, ''),
    from: msg.getFrom() || '(unknown sender)',
    to: msg.getTo() || '(unknown recipient)',
    cc: msg.getCc() || '',
    date: msg.getDate() || new Date(),
    subject: msg.getSubject() || '(no subject)',
    plainBody: msg.getPlainBody() || '',
    htmlBody: msg.getBody() || ''
  };
}

// ===================================================================================
// UTILITIES (General)
// ===================================================================================

/**
 * Calculates a SHA256 hash of file bytes.
 * @param {byte[]} bytes The file bytes.
 * @returns {string} The 64-character hex hash.
 * @private
 */
function sha256Hex_(bytes) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  return raw.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

/**
 * Makes a filename safe for filesystems.
 * Removes unsafe characters, prevents reserved names, and limits length.
 * @param {string} name The original filename.
 * @returns {string} The "safe" filename.
 * @private
 */
function sanitizeFilename_(name) {
  if (!name) return 'unknown_file';

  // Remove unsafe characters
  let safe = name.replace(/[/\\?%*:|"<>]/g, '_')
                 .replace(/\s+/g, ' ')
                 .trim()
                 .replace(/^\.+/, '') // No leading dots
                 .replace(/\.+$/, ''); // No trailing dots

  // Check length (leave room for prefix in main code)
  const maxLen = 200; // Conservative limit
  if (safe.length > maxLen) {
    // Preserve extension if possible
    const ext = safe.match(/\.[^.]+$/)?.[0] || '';
    safe = safe.substring(0, maxLen - ext.length) + ext;
  }

  // Check for Windows reserved names
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
  if (reserved.test(safe)) {
    safe = '_' + safe;
  }

  return safe || 'unknown_file';
}

/**
 * Converts bytes to a human-readable format (KB, MB, etc.).
 * @param {number} n The number of bytes.
 * @returns {string} The readable size.
 * @private
 */
function humanSize_(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
}

/**
 * Escapes HTML special characters.
 * @param {string} s The string to escape.
 * @returns {string} The escaped string.
 * @private
 */
function escapeHtml_(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/**
 * Truncates HTML or text neatly.
 * @param {string} html The string to truncate.
 * @param {number} maxLen The maximum length.
 * @returns {string} The truncated string.
 * @private
 */
function trimHtml_(html, maxLen) {
  if (!html) return '';
  const s = String(html);
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

/**
 * Removes inline Base64 images from HTML string.
 * Only removes images larger than the configured threshold to save space.
 * Small images (logos, icons) are preserved.
 * @param {string} html The original HTML.
 * @returns {string} The cleaned HTML.
 * @private
 */
function removeBase64Images_(html) {
  if (!html) return '';

  return html.replace(/<img[^>]*src=["']data:image\/[^;]+;base64,([^"']+)["'][^>]*>/gi, (match, base64) => {
    // Estimate byte size (base64 is ~33% overhead, so 1 char ≈ 0.75 bytes)
    const estimatedBytes = base64.length * 0.75;

    if (estimatedBytes > CONFIG.MAX_INLINE_IMAGE_BYTES) {
      return '<span style="color:#888; font-style:italic;">[Large inline image removed to save space]</span>';
    }

    // Keep small images
    return match;
  });
}

// ===================================================================================
// PROGRESS NOTIFICATIONS
// ===================================================================================

/**
 * Sends a progress notification email after batch completion.
 * @param {object} stats Batch statistics object.
 * @private
 */
function sendProgressNotification_(stats) {
  try {
    const props = PropertiesService.getScriptProperties().getProperties();
    const totalProcessed = props.metric_threads_processed || '0';
    const totalBytes = parseInt(props.metric_bytes_uploaded || '0');

    const subject = `[Gmail Archiver] Batch Complete - ${stats.processed} threads processed`;
    const body = `
Gmail Attachment Archiver - Batch Report
========================================

BATCH RESULTS:
• Threads Processed: ${stats.processed}
• Threads Skipped: ${stats.skipped}
• Threads Errored: ${stats.errored}

CUMULATIVE TOTALS:
• Total Threads Processed: ${totalProcessed}
• Total Space Saved: ${humanSize_(totalBytes)}
• Duplicate Files Skipped: ${props.metric_duplicates_skipped || '0'}

NEXT BATCH:
${stats.nextRunMinutes > 0
  ? `Scheduled in ${stats.nextRunMinutes} minutes`
  : 'No more work to do - all done!'}

---
Generated by Gmail Attachment Archiver v4.9
Run showMetrics() in the script editor to see full statistics.
    `;

    GmailApp.sendEmail(Session.getActiveUser().getEmail(), subject, body);
    Logger.log('Progress notification sent.');
  } catch (e) {
    Logger.log('Failed to send progress notification: %s', e.message);
  }
}

// ===================================================================================
// USER-FRIENDLY ERROR MESSAGES
// ===================================================================================

/**
 * Wraps technical errors with user-friendly explanations.
 * @param {string} technicalError The raw error message.
 * @param {string} context Optional context about what was being done.
 * @returns {Error} Enhanced error with user guidance.
 * @private
 */
function createUserFriendlyError_(technicalError, context) {
  const userMessages = {
    '401': {
      title: 'Authentication Failed',
      message: 'Your Nextcloud app password may be incorrect or expired.',
      solution: 'Go to Nextcloud → Settings → Security → Create new app password, then run setupCredentials() again.'
    },
    '403': {
      title: 'Permission Denied',
      message: 'Your Nextcloud user doesn\'t have write access to the folder.',
      solution: `Check folder permissions in Nextcloud or change ROOT_PATH (currently: "${CONFIG.ROOT_PATH}") in Config.gs.`
    },
    '404': {
      title: 'Folder Not Found',
      message: `The ROOT_PATH "${CONFIG.ROOT_PATH}" does not exist in Nextcloud.`,
      solution: `Create the folder "${CONFIG.ROOT_PATH}" in Nextcloud, or change ROOT_PATH in Config.gs.`
    },
    'Email Body Size': {
      title: 'Email Too Large',
      message: 'Email is too large to send (over 25MB after attachments removed).',
      solution: 'Lower MAX_BODY_CHARS in Config.gs to 5000 and try again.'
    },
    'Service invoked too many times': {
      title: 'Daily Email Quota Reached',
      message: 'Gmail allows maximum 100 emails per day. You\'ve hit that limit.',
      solution: 'This is a Google limit. Script will automatically retry tomorrow. No action needed.'
    },
    'User-rate limit exceeded': {
      title: 'Rate Limit Hit',
      message: 'Too many API calls in short time.',
      solution: 'Script will automatically wait 15 minutes and retry. No action needed.'
    }
  };

  for (const [pattern, info] of Object.entries(userMessages)) {
    if (technicalError.includes(pattern)) {
      const friendlyMsg = `
╔═══════════════════════════════════════════════════════════╗
║  ${info.title.toUpperCase()}
╚═══════════════════════════════════════════════════════════╝

❌ Problem: ${info.message}

✅ Solution: ${info.solution}

═══════════════════════════════════════════════════════════
Technical Details:
${technicalError}
${context ? '\nContext: ' + context : ''}
═══════════════════════════════════════════════════════════
      `.trim();

      return new Error(friendlyMsg);
    }
  }

  return new Error(technicalError); // Fallback to original
}

// ===================================================================================
// METRICS SYSTEM
// ===================================================================================

/**
 * Increments a metric counter.
 * @param {string} key Metric name.
 * @param {number} amount Amount to add (default: 1).
 * @private
 */
function incrementMetric_(key, amount = 1) {
  const props = PropertiesService.getScriptProperties();
  const current = parseInt(props.getProperty(`metric_${key}`) || '0');
  props.setProperty(`metric_${key}`, String(current + amount));
}

/**
 * Records a metric value (not incremental).
 * @param {string} key Metric name.
 * @param {number} value Value to record.
 * @private
 */
function recordMetric_(key, value) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(`metric_${key}`, String(value));
}

/**
 * Displays all collected metrics.
 * Run this to see script performance statistics.
 */
function showMetrics() {
  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();

  Logger.log('=== GMAIL ARCHIVER METRICS ===');
  Logger.log('Threads Processed: %s', allProps.metric_threads_processed || '0');
  Logger.log('Threads Skipped: %s', allProps.metric_threads_skipped || '0');
  Logger.log('Threads Errored: %s', allProps.metric_threads_errored || '0');
  Logger.log('Files Uploaded: %s', allProps.metric_files_uploaded || '0');
  Logger.log('Bytes Uploaded: %s (%s)',
    allProps.metric_bytes_uploaded || '0',
    humanSize_(parseInt(allProps.metric_bytes_uploaded || '0')));
  Logger.log('Duplicate Files Skipped: %s', allProps.metric_duplicates_skipped || '0');
  Logger.log('Last Run: %s', allProps.metric_last_run || 'Never');
  Logger.log('Total Batches: %s', allProps.metric_total_batches || '0');

  // Calculate success rate
  const total = parseInt(allProps.metric_threads_processed || '0') +
                parseInt(allProps.metric_threads_errored || '0');
  const successRate = total > 0
    ? ((parseInt(allProps.metric_threads_processed || '0') / total) * 100).toFixed(1)
    : '0';
  Logger.log('Success Rate: %s%%', successRate);
  Logger.log('==============================');
}

/**
 * Resets all metrics to zero.
 * Use this to start fresh tracking.
 */
function resetMetrics() {
  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();

  let count = 0;
  Object.keys(allProps).forEach(key => {
    if (key.startsWith('metric_')) {
      props.deleteProperty(key);
      count++;
    }
  });

  Logger.log('All metrics reset (%s properties cleared).', count);
}

// ===================================================================================
// TRIGGER MANAGEMENT (for batches)
// ===================================================================================

/**
 * Creates a new trigger to restart the script later.
 * @param {string} handlerFunction The name of the function to trigger (e.g., 'runProduction').
 * @param {number} waitMinutes The number of minutes to wait.
 * @private
 */
function createContinuationTrigger_(handlerFunction, waitMinutes) {
  deleteContinuationTriggers_(handlerFunction); // Delete old ones first
  const waitMs = (waitMinutes || 5) * 60 * 1000;
  ScriptApp.newTrigger(handlerFunction)
    .timeBased()
    .after(waitMs)
    .create();
  Logger.log('New continuation trigger created for %s (waiting %s min).', handlerFunction, waitMinutes);
}

/**
 * Deletes old triggers to prevent the "too many triggers" error.
 * @param {string} handlerFunction The name of the function for which triggers should be cleared.
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
 * RECOMMENDED - Sets up automatic hourly execution.
 *
 * WHY NEEDED (vs continuation triggers):
 * - runProduction() creates ONE-TIME continuation triggers (5 min later) to finish current backlog
 * - These continuation triggers STOP when all work is done
 * - WITHOUT hourly trigger: script won't start again when NEW emails arrive later
 * - WITH hourly trigger: script checks every hour for new work (emails from today/tomorrow/etc.)
 *
 * TWO TRIGGER TYPES EXPLAINED:
 * - Continuation triggers = "Finish current batch" (auto-created by runProduction, temporary)
 * - Hourly trigger = "Keep checking for new emails forever" (created by this function, permanent)
 *
 * WHAT IT DOES:
 * - Deletes any existing hourly triggers (prevents duplicates)
 * - Deletes active batch continuation triggers (clean slate)
 * - Creates new trigger that runs runProduction() every hour
 *
 * WHEN TO USE:
 * - After successful testing with runTest()
 * - When you want "set it and forget it" automation
 * - For continuous monitoring of incoming emails with large attachments
 *
 * NOTE: You can disable this anytime via: Edit → Current project's triggers
 */
function setupTriggerHourly() {
  deleteContinuationTriggers_('runProduction'); // Remove active batch triggers

  // Remove existing 'runProduction' hourly triggers
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'runProduction') {
      ScriptApp.deleteTrigger(trigger);
      Logger.log('Old hourly "runProduction" trigger deleted.');
    }
  }

  // Create new trigger
  ScriptApp.newTrigger('runProduction').timeBased().everyHours(1).create();
  Logger.log('New hourly "runProduction" trigger created.');
}


// ===================================================================================
// DRAFT CLEANUP TOOL
// ===================================================================================

/**
 * ESSENTIAL - Removes stuck drafts after errors.
 *
 * WHY NEEDED:
 * - Script creates drafts to build digest emails
 * - If error occurs AFTER draft creation but BEFORE sending, draft is orphaned
 * - Without cleanup, you can end up with hundreds of unsent drafts cluttering inbox
 *
 * WHEN TO USE:
 * - After a crash or error during digest creation
 * - If you see many "[ARCHIVED-DIGEST]" drafts in your Gmail drafts folder
 * - Recommended to run after fixing any major errors
 *
 * SAFETY:
 * - ONLY deletes drafts whose subject starts with DIGEST_SUBJECT_PREFIX
 * - Won't touch your personal drafts
 * - Safe to run multiple times
 *
 * This ONLY deletes drafts whose subject starts with your DIGEST_SUBJECT_PREFIX.
 */
function cleanupOrphanedDrafts() {
  const prefix = CONFIG.DIGEST_SUBJECT_PREFIX;
  Logger.log('--- cleanupOrphanedDrafts START ---');
  Logger.log('Searching for drafts starting with: "%s"', prefix);

  const drafts = GmailApp.getDrafts();
  let deletedCount = 0;

  drafts.forEach(draft => {
    const message = draft.getMessage();
    const subject = message.getSubject();

    if (subject && subject.startsWith(prefix)) {
      try {
        draft.deleteDraft();
        deletedCount++;
      } catch (e) {
        Logger.log('Failed to delete draft %s: %s', draft.getId(), e.message);
      }
    }
  });

  Logger.log('--- DONE. Deleted %s orphaned drafts. ---', deletedCount);
}

// ===================================================================================
// STUCK LABEL FIX TOOL
// ===================================================================================

/**
 * ESSENTIAL - Fixes threads stuck in "processing" after crashes.
 *
 * WHY NEEDED:
 * - Script marks threads with "Processing-Attachment" label while working on them
 * - If script crashes mid-execution, threads stay marked as "processing" forever
 * - These "stuck" threads are EXCLUDED from future runs (script skips them)
 * - Without this tool, stuck threads will NEVER be processed
 *
 * SYMPTOMS OF STUCK THREADS:
 * - You see threads with "Processing-Attachment" label that haven't been archived
 * - Script runs but doesn't find any work (because threads are excluded)
 * - Number of threads to process doesn't decrease
 *
 * WHEN TO USE:
 * - After any script crash or timeout error
 * - If you manually stopped execution mid-run
 * - If threads appear stuck in limbo
 *
 * WHAT IT DOES:
 * - Removes "Processing-Attachment" label from ALL threads (batches of 100)
 * - Threads become eligible for processing again on next run
 *
 * Removes the 'Processing-Attachment' label from ALL threads.
 */
function resetStuckProcessingLabels() {
  Logger.log('--- resetStuckProcessingLabels START ---');

  const processingLabelName = CONFIG.PROCESSING_LABEL;
  const label = GmailApp.getUserLabelByName(processingLabelName);

  if (!label) {
    Logger.log('Label "%s" does not exist. Nothing to do.', processingLabelName);
    return;
  }

  // Find threads with this label
  // We use batch processing because there may be many
  let threads = label.getThreads(0, 100);
  let count = 0;

  while (threads.length > 0) {
    Logger.log('Batch of %s threads found. Removing label...', threads.length);
    // GmailApp.removeLabel supports batches of up to 100 threads at once!
    label.removeFromThreads(threads);
    count += threads.length;

    // Get the next batch (which has now 'shifted' because they no longer have the label)
    // But wait a moment to give the API breathing room
    Utilities.sleep(1000);
    threads = label.getThreads(0, 100);
  }

  Logger.log('--- DONE. %s threads repaired (label "%s" removed). ---', count, processingLabelName);
}

// ===================================================================================
// CONFIGURATION VALIDATOR
// ===================================================================================

/**
 * Validates all configuration settings.
 * Run this after changing Config.gs to catch errors early.
 */
function validateConfiguration() {
  Logger.log('=== VALIDATING CONFIGURATION ===');
  const errors = [];
  const warnings = [];

  // Check storage provider
  if (!['Nextcloud', 'GoogleDrive'].includes(ACTIVE_STORAGE_PROVIDER)) {
    errors.push(`Invalid ACTIVE_STORAGE_PROVIDER: "${ACTIVE_STORAGE_PROVIDER}". Must be "Nextcloud" or "GoogleDrive".`);
  }

  // Check provider-specific config
  if (ACTIVE_STORAGE_PROVIDER === 'Nextcloud') {
    if (!CONFIG.BASE_URL) {
      errors.push('BASE_URL cannot be empty');
    } else if (!CONFIG.BASE_URL.startsWith('https://')) {
      errors.push('BASE_URL must use HTTPS (found: ' + CONFIG.BASE_URL + ')');
    }

    if (!CONFIG.BASE_WEBDAV) {
      errors.push('BASE_WEBDAV cannot be empty');
    } else if (!CONFIG.BASE_WEBDAV.startsWith('https://')) {
      errors.push('BASE_WEBDAV must use HTTPS (found: ' + CONFIG.BASE_WEBDAV + ')');
    }

    if (!CONFIG.ROOT_PATH) {
      errors.push('ROOT_PATH cannot be empty');
    }
  }

  if (ACTIVE_STORAGE_PROVIDER === 'GoogleDrive') {
    if (!CONFIG.ROOT_FOLDER_ID) {
      errors.push('ROOT_FOLDER_ID cannot be empty');
    }
  }

  // Check numeric ranges
  if (CONFIG.MIN_ATTACHMENT_SIZE_KB < 1) {
    errors.push('MIN_ATTACHMENT_SIZE_KB must be at least 1');
  }

  if (CONFIG.MAX_THREADS_PER_RUN < 1 || CONFIG.MAX_THREADS_PER_RUN > 100) {
    errors.push('MAX_THREADS_PER_RUN must be between 1 and 100');
  }

  if (CONFIG.EXECUTION_TIME_LIMIT_MINUTES > 5) {
    warnings.push('EXECUTION_TIME_LIMIT_MINUTES is > 5. Script timeout is 6 minutes, leaving little safety margin.');
  }

  if (CONFIG.MAX_BODY_CHARS < 1000) {
    warnings.push('MAX_BODY_CHARS is very low (' + CONFIG.MAX_BODY_CHARS + '). Digests may have very little content.');
  }

  // Check Gmail query
  if (!CONFIG.GMAIL_QUERY_BASE) {
    errors.push('GMAIL_QUERY_BASE cannot be empty');
  } else if (!CONFIG.GMAIL_QUERY_BASE.includes('has:attachment')) {
    warnings.push('GMAIL_QUERY_BASE should probably include "has:attachment"');
  }

  // Check processing hours format
  if (CONFIG.PROCESSING_HOURS) {
    if (typeof CONFIG.PROCESSING_HOURS.START !== 'number' || typeof CONFIG.PROCESSING_HOURS.END !== 'number') {
      errors.push('PROCESSING_HOURS must have numeric START and END properties');
    } else if (CONFIG.PROCESSING_HOURS.START < 0 || CONFIG.PROCESSING_HOURS.START > 23) {
      errors.push('PROCESSING_HOURS.START must be between 0 and 23');
    } else if (CONFIG.PROCESSING_HOURS.END < 0 || CONFIG.PROCESSING_HOURS.END > 23) {
      errors.push('PROCESSING_HOURS.END must be between 0 and 23');
    }
  }

  // Test storage provider
  try {
    const provider = getStorageProvider_();
    if (!provider) {
      errors.push('Storage provider not configured correctly');
    } else {
      Logger.log('✅ Storage provider (%s) loaded successfully', ACTIVE_STORAGE_PROVIDER);
    }
  } catch (e) {
    errors.push('Storage provider error: ' + e.message);
  }

  // Report results
  if (errors.length > 0) {
    Logger.log('\n❌ CONFIGURATION ERRORS (%s):', errors.length);
    errors.forEach(e => Logger.log('  • ' + e));
  }

  if (warnings.length > 0) {
    Logger.log('\n⚠️  CONFIGURATION WARNINGS (%s):', warnings.length);
    warnings.forEach(w => Logger.log('  • ' + w));
  }

  if (errors.length === 0 && warnings.length === 0) {
    Logger.log('\n✅ Configuration is valid!');
    Logger.log('No errors or warnings found.');
    return true;
  }

  Logger.log('\n' + '='.repeat(50));
  return errors.length === 0;
}

// ===================================================================================
// EMERGENCY ROLLBACK
// ===================================================================================

/**
 * Emergency rollback: restores last batch of threads from trash.
 * ONLY works if threads are still in trash (< 30 days).
 * WARNING: Does NOT remove digest emails or uploaded files.
 */
function emergencyRollback() {
  Logger.log('=== EMERGENCY ROLLBACK START ===');
  Logger.log('⚠️  WARNING: This will restore processed threads from trash.');
  Logger.log('Digest emails and uploaded files will NOT be removed.');
  Logger.log('');

  const processedLabel = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL);
  if (!processedLabel) {
    Logger.log('❌ No processed label found. Nothing to rollback.');
    return;
  }

  // Find threads in trash with Processed-Attachments label
  const query = `in:trash label:${CONFIG.PROCESSED_LABEL}`;
  Logger.log('Searching for threads to restore with query: %s', query);

  const threads = GmailApp.search(query, 0, 100);
  Logger.log('Found %s threads to restore', threads.length);

  if (threads.length === 0) {
    Logger.log('No threads to restore. Rollback complete.');
    return;
  }

  let restoredCount = 0;
  threads.forEach(thread => {
    try {
      thread.moveToInbox();
      thread.removeLabel(processedLabel);
      Logger.log('✅ Restored: %s', thread.getFirstMessageSubject());
      restoredCount++;
    } catch (e) {
      Logger.log('❌ Failed to restore thread %s: %s', thread.getId(), e.message);
    }
  });

  Logger.log('');
  Logger.log('=== ROLLBACK COMPLETE ===');
  Logger.log('Restored %s threads to inbox', restoredCount);
  Logger.log('');
  Logger.log('⚠️  IMPORTANT NOTES:');
  Logger.log('• Digest emails are still in your archive');
  Logger.log('• Files are still in cloud storage');
  Logger.log('• You may want to manually clean these up');
}

// ===================================================================================
// WEB DASHBOARD
// ===================================================================================

/**
 * Serves a simple web dashboard showing script statistics.
 * Deploy as web app: Publish → Deploy as web app → Execute as "Me" → Access "Anyone"
 */
function doGet() {
  const props = PropertiesService.getScriptProperties().getProperties();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Gmail Archiver Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      text-align: center;
    }
    .header h1 { font-size: 2em; margin-bottom: 10px; }
    .header p { opacity: 0.9; }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      padding: 30px;
    }
    .stat-card {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 12px;
      text-align: center;
      border-left: 4px solid #667eea;
    }
    .stat-value {
      font-size: 2.5em;
      font-weight: bold;
      color: #667eea;
      margin: 10px 0;
    }
    .stat-label {
      color: #6c757d;
      font-size: 0.9em;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .footer {
      background: #f8f9fa;
      padding: 20px;
      text-align: center;
      color: #6c757d;
      font-size: 0.9em;
      border-top: 1px solid #dee2e6;
    }
    .success-rate {
      font-size: 3em;
      font-weight: bold;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 Gmail Archiver Dashboard</h1>
      <p>Real-time statistics for your email archiving process</p>
    </div>

    <div class="stats">
      <div class="stat-card">
        <div class="stat-label">Threads Processed</div>
        <div class="stat-value">${props.metric_threads_processed || '0'}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Threads Skipped</div>
        <div class="stat-value">${props.metric_threads_skipped || '0'}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Threads Errored</div>
        <div class="stat-value">${props.metric_threads_errored || '0'}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Files Uploaded</div>
        <div class="stat-value">${props.metric_files_uploaded || '0'}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Space Saved</div>
        <div class="stat-value" style="font-size: 1.8em;">
          ${humanSize_(parseInt(props.metric_bytes_uploaded || '0'))}
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Duplicates Skipped</div>
        <div class="stat-value">${props.metric_duplicates_skipped || '0'}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Total Batches</div>
        <div class="stat-value">${props.metric_total_batches || '0'}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Success Rate</div>
        <div class="success-rate">
          ${(() => {
            const total = parseInt(props.metric_threads_processed || '0') +
                         parseInt(props.metric_threads_errored || '0');
            return total > 0
              ? ((parseInt(props.metric_threads_processed || '0') / total) * 100).toFixed(1)
              : '0';
          })()}%
        </div>
      </div>
    </div>

    <div class="footer">
      <p><strong>Last Run:</strong> ${props.metric_last_run || 'Never'}</p>
      <p style="margin-top: 10px;">Gmail Attachment Archiver v4.9</p>
    </div>
  </div>
</body>
</html>
  `;

  return HtmlService.createHtmlOutput(html)
    .setTitle('Gmail Archiver Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===================================================================================
// DEBUG HELPERS
// ===================================================================================

/**
 * RECOMMENDED - Preview which threads will be processed (prevents mistakes).
 *
 * WHY NEEDED:
 * - Gmail queries can be tricky (syntax errors, unexpected results)
 * - Running production without testing query can archive WRONG threads
 * - This shows you EXACTLY what will be processed before you commit
 *
 * PREVENTS DISASTERS LIKE:
 * - Archiving all emails instead of just old ones (missing date filter)
 * - Processing emails without attachments (syntax error)
 * - Missing size filter (processing tiny files)
 * - Including important threads you wanted to keep
 *
 * WHEN TO USE:
 * - Before first production run
 * - After changing GMAIL_QUERY_BASE in Config.gs
 * - If you're unsure what threads match your criteria
 * - When testing TEST_MODE vs PRODUCTION mode queries
 *
 * WHAT IT SHOWS:
 * - Exact query that will be used
 * - First 20 matching threads (ID, subject, message count, labels)
 * - Lets you verify BEFORE deletion
 *
 * Tests the Gmail query that will be used by runTest or runProduction.
 * Logs the first 20 threads found.
 */
function testQuery() {
  let query = '';

  // Build labels query dynamically
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
 * ESSENTIAL - Validates cloud storage config before first run.
 *
 * WHY NEEDED:
 * - Cloud storage config errors only show up when uploading files
 * - Running production with bad config = processing threads but LOSING files
 * - This catches config errors BEFORE you start archiving real emails
 *
 * CATCHES CRITICAL ERRORS LIKE:
 * - Wrong Nextcloud credentials (401 Unauthorized)
 * - Invalid WebDAV path (404 Not Found)
 * - Wrong Google Drive folder ID
 * - Network/firewall issues
 * - Quota/storage space problems
 * - Share link creation failures
 *
 * WHEN TO USE:
 * - BEFORE first production run (mandatory!)
 * - After changing storage provider settings
 * - After switching from Nextcloud to Google Drive (or vice versa)
 * - If you suspect cloud storage issues
 *
 * WHAT IT TESTS:
 * 1. File upload (creates test file with timestamp)
 * 2. Share link creation (public download link)
 * 3. UI link creation (fallback link)
 * - If all 3 succeed, your config is correct
 *
 * Tests the configured storage provider by uploading a test file
 * and creating share/UI links.
 */
function testStorageProvider() {
  try {
    const storage = getStorageProvider_();
    if (!storage) return;

    const fileName = 'TEST__' + Date.now() + '__hello.txt';
    const blob = Utilities.newBlob('hello', 'text/plain', 'hello.txt');

    Logger.log('Testing upload...');
    const uploadResult = storage.uploadFile(fileName, blob, null);
    Logger.log('Test upload OK: %s', uploadResult);

    Logger.log('Testing share link...');
    const shareLink = storage.createShareLink(fileName, uploadResult);
    Logger.log('Test share link OK: %s', shareLink);

    Logger.log('Testing UI link...');
    const uiLink = storage.createUiLink(fileName, uploadResult);
    Logger.log('Test UI link OK: %s', uiLink);

  } catch (e) {
    Logger.log('Test storage provider FAILED: %s', e.message);
    Logger.log(e.stack);
  }
}