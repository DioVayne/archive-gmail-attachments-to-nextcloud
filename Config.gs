/**
 * ===================================================================================
 * GMAIL ARCHIVER - CONFIGURATION FILE (v4.8)
 * ===================================================================================
 * This file contains all user settings.
 */

/**
 * ===================================================================================
 * STEP 1: CHOOSE YOUR STORAGE PROVIDER
 * ===================================================================================
 * Select which cloud provider you want to use.
 * The corresponding connector (e.g., 'Nextcloud_Connector.gs') must be present in the project.
 *
 * Options: 'Nextcloud', 'GoogleDrive'
 */
const ACTIVE_STORAGE_PROVIDER = 'Nextcloud';


/**
 * ===================================================================================
 * STEP 2: SENSITIVE CONFIGURATION
 * Fill this in and run `setupCredentials()` ONCE.
 * After that, remove your password from this block for security.
 * ===================================================================================
 */
const USER_CONFIG_SENSITIVE = {

  // --- Nextcloud Settings (only needed if ACTIVE_STORAGE_PROVIDER = 'Nextcloud') ---
  NEXTCLOUD_USER: 'XXX',
  NEXTCLOUD_APP_PASSWORD: 'XXX', // <-- PASTE YOUR PASSWORD HERE

  // --- Google Drive Settings (only needed if ACTIVE_STORAGE_PROVIDER = 'GoogleDrive') ---
  // No password needed; authentication is automatic.

  // --- Dropbox Settings (example for future extension) ---
  // DROPBOX_ACCESS_TOKEN: 'YOUR_TOKEN_HERE'
};


/**
 * ===================================================================================
 * STEP 3: GENERAL CONFIGURATION
 * Adjust all non-sensitive values in this object.
 * ===================================================================================
 */
const USER_CONFIG_GENERAL = {

  // --- Test Mode ---
  // This is a SAFETY SWITCH.
  // If true, `runProduction()` will refuse to start.
  // You must use the special `runTest()` function.
  TEST_MODE: false,
  TEST_MODE_LABEL: 'test-gmail-cleanup',

  // --- Provider-Specific Settings ---

  NEXTCLOUD_CONFIG: {
    BASE_URL: 'https://XXX',
    BASE_WEBDAV: 'https://XXX',
    ROOT_PATH: 'MailAttachments', // Folder in Nextcloud
    USE_PUBLIC_LINKS: true,
    PUBLIC_LINK_EXPIRE_DAYS: 0, // 0 = Never expires
    PUBLIC_LINK_PASSWORD: ''    // '' = No password
  },

  GOOGLE_DRIVE_CONFIG: {
    // Replace this with the ID of the Google Drive folder where you want to store files.
    // You can find the ID in the URL (e.g., .../folders/THIS_ID_CODE)
    ROOT_FOLDER_ID: 'YOUR_GOOGLE_DRIVE_FOLDER_ID_HERE'
  },

  // --- Gmail Search Query ---
  // Base query when *TEST_MODE is false*.
  // The script automatically adds size filter (e.g., `larger:100k`) and exclusion labels.
  GMAIL_QUERY_BASE: 'has:attachment older_than:180d -in:spam -in:trash',

  // --- Attachment Size Threshold ---
  // The single source of truth for attachment size (in KB).
  MIN_ATTACHMENT_SIZE_KB: 100,

  // --- Digest & Labels (Script creates these automatically) ---
  DIGEST_SUBJECT_PREFIX: '[ARCHIVED-DIGEST]',
  PROCESSED_LABEL: 'Processed-Attachments',
  PROCESSING_LABEL: 'Processing-Attachment',
  PROCESSED_SKIPPED_LABEL: 'Processed-Skipped',
  PROCESSED_ERROR_LABEL: 'Processed-Error',

  // --- Performance & Limits ---
  MAX_THREADS_PER_RUN: 30,
  EXECUTION_TIME_LIMIT_MINUTES: 5,
  SLEEP_AFTER_UPLOAD_MS: 1500,
  SLEEP_BETWEEN_THREADS_MS: 1000,

  // --- Email Body Size Limit ---
  // Maximum characters per message in digest before truncation (prevents Gmail size errors).
  MAX_BODY_CHARS: 10000,

  // --- Other ---
  INCLUDE_INLINE_IMAGES: true,

  // --- Base64 Image Size Threshold ---
  // Remove inline base64 images larger than this size (in bytes) to save space.
  // Small images (logos, icons) below this threshold will be preserved.
  MAX_INLINE_IMAGE_BYTES: 50000, // 50KB

  // --- Preview / Dry Run Mode ---
  // If true, script logs what would be done but doesn't upload/delete anything.
  // Use this to safely preview what will be processed.
  PREVIEW_MODE: false,

  // --- Cross-Thread Deduplication ---
  // If true, skips uploading files that were already uploaded in other threads.
  // Uses CacheService with 24-hour retention.
  ENABLE_GLOBAL_DEDUPLICATION: true,

  // --- Progress Notifications ---
  // If true, sends email notification after each batch completes.
  SEND_PROGRESS_EMAILS: false,

  // --- Smart Scheduling ---
  // Only process during these hours (24-hour format). Set to null to disable.
  PROCESSING_HOURS: null,  // Example: { START: 2, END: 6 } for 2 AM - 6 AM
};
// ===================================================================================
// END CONFIGURATION
// ===================================================================================


// --- Global Constants (Derived) ---
// Validate and combine the general config with the *active* provider's config
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

const CONFIG = {
  ...USER_CONFIG_GENERAL,
  ...USER_CONFIG_GENERAL[`${ACTIVE_STORAGE_PROVIDER.toUpperCase()}_CONFIG`],
  // Calculate the byte threshold from the KB config
  SIZE_THRESHOLD_BYTES: USER_CONFIG_GENERAL.MIN_ATTACHMENT_SIZE_KB * 1024
};

/**
 * ===================================================================================
 * STEP 4: CREDENTIALS SETUP
 * Run this function ONCE to securely store your passwords.
 * ===================================================================================
 */
function setupCredentials() {
  const provider = getStorageProvider_();
  provider.initialize();
  Logger.log('Credentials successfully stored in PropertiesService.');
  Logger.log('IMPORTANT: Now remove your password from `USER_CONFIG_SENSITIVE`!');
}