/**
 * ===================================================================================
 * GMAIL ARCHIVER - CONFIGURATION FILE (v4.9.1)
 * ===================================================================================
 * ALL settings you need to configure are at the TOP of this file.
 * No scrolling needed - everything is organized by priority.
 */

// ===================================================================================
// ✅ SECTION 1: REQUIRED SETTINGS (YOU MUST CONFIGURE THESE)
// ===================================================================================

/**
 * STEP 1: Choose your storage provider
 * Options: 'Nextcloud' or 'GoogleDrive'
 */
const ACTIVE_STORAGE_PROVIDER = 'Nextcloud';

/**
 * STEP 2: Provider credentials and paths
 * Fill in the section for YOUR chosen provider (Nextcloud OR Google Drive)
 */
const USER_CONFIG_SENSITIVE = {
  // --- NEXTCLOUD CREDENTIALS (only if ACTIVE_STORAGE_PROVIDER = 'Nextcloud') ---
  NEXTCLOUD_USER: 'XXX',                    // Your Nextcloud username
  NEXTCLOUD_APP_PASSWORD: 'XXX',            // <-- PASTE APP PASSWORD HERE, then run setupCredentials()

  // --- GOOGLE DRIVE (only if ACTIVE_STORAGE_PROVIDER = 'GoogleDrive') ---
  // No credentials needed - authentication is automatic
};

const NEXTCLOUD_CONFIG = {
  BASE_URL: 'https://XXX',                   // Your Nextcloud URL (e.g., https://cloud.example.com)
  BASE_WEBDAV: 'https://XXX',                // WebDAV path (e.g., https://cloud.example.com/remote.php/dav/files/username)
  ROOT_PATH: 'MailAttachments',              // Folder name in Nextcloud where files will be stored
  USE_PUBLIC_LINKS: true,                    // Create public download links? (true/false)
  PUBLIC_LINK_EXPIRE_DAYS: 0,                // Link expiration in days (0 = never expires)
  PUBLIC_LINK_PASSWORD: ''                   // Password for links ('' = no password)
};

const GOOGLE_DRIVE_CONFIG = {
  ROOT_FOLDER_ID: 'YOUR_GOOGLE_DRIVE_FOLDER_ID_HERE'  // Get this from Drive folder URL: .../folders/THIS_ID_CODE
};

/**
 * STEP 3: Gmail search criteria
 * Customize which emails to process
 */
const GMAIL_QUERY_BASE = 'has:attachment older_than:180d -in:spam -in:trash';  // Base Gmail search query
const MIN_ATTACHMENT_SIZE_KB = 100;                                             // Only process attachments larger than this (in KB)


// ===================================================================================
// ⚙️ SECTION 2: OPTIONAL SETTINGS (Defaults are fine, but you can customize)
// ===================================================================================

/**
 * Test Mode Settings
 * Use runTest() to safely test on 1 labeled thread before production
 */
const TEST_MODE = false;                     // SAFETY: Must be false to run runProduction()
const TEST_MODE_LABEL = 'test-gmail-cleanup'; // Label for test threads (you create this manually)

/**
 * Performance & Batch Settings
 * Control how fast/aggressive the script processes emails
 */
const MAX_THREADS_PER_RUN = 30;              // Max threads per batch (1-100, recommended: 30)
const EXECUTION_TIME_LIMIT_MINUTES = 5;      // Stop before timeout (max: 5, Apps Script limit: 6)
const SLEEP_AFTER_UPLOAD_MS = 1500;          // Wait time after uploading files (milliseconds)
const SLEEP_BETWEEN_THREADS_MS = 1000;       // Wait time between threads (milliseconds)

/**
 * Advanced Features (v4.9)
 * Enable/disable new functionality
 */
const PREVIEW_MODE = false;                  // Dry run: logs actions without uploading/deleting (true/false)
const ENABLE_GLOBAL_DEDUPLICATION = true;    // Skip files uploaded in other threads (24h cache, true/false)
const SEND_PROGRESS_EMAILS = false;          // Email notification after each batch (true/false)
const PROCESSING_HOURS = null;               // Time window: { START: 2, END: 6 } for 2 AM-6 AM, or null = always

/**
 * Email Content Settings
 * Control how digest emails are formatted
 */
const MAX_BODY_CHARS = 20000;                // Max characters per message in digest (default: 20000)
                                             // ⚠️ SAFETY: Script refuses to process threads if >50% data loss would occur
                                             // Increase if you see "EXCESSIVE DATA LOSS" errors in logs
const MAX_INLINE_IMAGE_BYTES = 50000;        // Remove base64 images larger than this (bytes, default: 50KB)
const INCLUDE_INLINE_IMAGES = true;          // Extract inline images as attachments (true/false)
const STRIP_QUOTED_CONTENT = false;          // Remove quoted/forwarded content ("> Original message", etc.)
                                             // ⚠️ EXPERIMENTAL: May reduce digest size but could remove important context
                                             // Set to true only if threads have excessive quote nesting

/**
 * Label Names
 * Gmail labels created by the script (change if you want different names)
 */
const DIGEST_SUBJECT_PREFIX = '[ARCHIVED-DIGEST]';   // Prefix for digest email subjects
const PROCESSED_LABEL = 'Processed-Attachments';     // Label for successfully archived threads (in trash)
const PROCESSING_LABEL = 'Processing-Attachment';    // Temporary label while processing
const PROCESSED_SKIPPED_LABEL = 'Processed-Skipped'; // Label for threads with no large attachments
const PROCESSED_ERROR_LABEL = 'Processed-Error';     // Label for threads that failed permanently


// ===================================================================================
// 🔒 SECTION 3: TECHNICAL (DO NOT EDIT BELOW THIS LINE)
// ===================================================================================

// Combine all settings into one object
const USER_CONFIG_GENERAL = {
  TEST_MODE,
  TEST_MODE_LABEL,
  NEXTCLOUD_CONFIG,
  GOOGLE_DRIVE_CONFIG,
  GMAIL_QUERY_BASE,
  MIN_ATTACHMENT_SIZE_KB,
  MAX_THREADS_PER_RUN,
  EXECUTION_TIME_LIMIT_MINUTES,
  SLEEP_AFTER_UPLOAD_MS,
  SLEEP_BETWEEN_THREADS_MS,
  PREVIEW_MODE,
  ENABLE_GLOBAL_DEDUPLICATION,
  SEND_PROGRESS_EMAILS,
  PROCESSING_HOURS,
  MAX_BODY_CHARS,
  MAX_INLINE_IMAGE_BYTES,
  INCLUDE_INLINE_IMAGES,
  STRIP_QUOTED_CONTENT,
  DIGEST_SUBJECT_PREFIX,
  PROCESSED_LABEL,
  PROCESSING_LABEL,
  PROCESSED_SKIPPED_LABEL,
  PROCESSED_ERROR_LABEL
};

// Validate configuration at load time
(function validateConfig() {
  const providerKey = `${ACTIVE_STORAGE_PROVIDER.toUpperCase()}_CONFIG`;
  if (!USER_CONFIG_GENERAL[providerKey]) {
    throw new Error(`Configuration for provider "${ACTIVE_STORAGE_PROVIDER}" not found. Check ACTIVE_STORAGE_PROVIDER in Config.gs`);
  }

  // Validate HTTPS for Nextcloud
  if (ACTIVE_STORAGE_PROVIDER === 'Nextcloud') {
    const nc = USER_CONFIG_GENERAL.NEXTCLOUD_CONFIG;
    if (!nc.BASE_URL.startsWith('https://')) {
      throw new Error('SECURITY: Nextcloud BASE_URL must use HTTPS');
    }
    if (!nc.BASE_WEBDAV.startsWith('https://')) {
      throw new Error('SECURITY: Nextcloud BASE_WEBDAV must use HTTPS');
    }
  }
})();

// Create final CONFIG object with derived values
const CONFIG = {
  ...USER_CONFIG_GENERAL,
  ...USER_CONFIG_GENERAL[`${ACTIVE_STORAGE_PROVIDER.toUpperCase()}_CONFIG`],
  SIZE_THRESHOLD_BYTES: USER_CONFIG_GENERAL.MIN_ATTACHMENT_SIZE_KB * 1024
};

/**
 * ===================================================================================
 * STEP 4: CREDENTIALS SETUP
 * Run this function ONCE after filling in credentials above
 * ===================================================================================
 */
function setupCredentials() {
  const provider = getStorageProvider_();
  provider.initialize();
  Logger.log('✅ Credentials successfully stored in PropertiesService.');
  Logger.log('⚠️ IMPORTANT: Now remove your password from USER_CONFIG_SENSITIVE for security!');
}
