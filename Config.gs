/**
 * ===================================================================================
 * GMAIL ARCHIVER - CONFIGURATIEBESTAND (v3.0)
 * ===================================================================================
 * Dit bestand bevat alle gebruikersinstellingen.
 */

/**
 * ===================================================================================
 * STAP 1: KIES JE OPSLAGPROVIDER
 * ===================================================================================
 * Kies welke cloud-provider je wilt gebruiken.
 * De bijbehorende connector (bijv. 'Nextcloud_Connector.gs') moet in het project aanwezig zijn.
 *
 * Opties: 'Nextcloud', 'GoogleDrive'
 */
const ACTIVE_STORAGE_PROVIDER = 'Nextcloud';


/**
 * ===================================================================================
 * STAP 2: GEVOELIGE CONFIGURATIE
 * Vul dit in en draai `setupCredentials()` EENMALIG.
 * Verwijder daarna je wachtwoord uit dit blok voor de veiligheid.
 * ===================================================================================
 */
const USER_CONFIG_SENSITIVE = {
  
  // --- Nextcloud Instellingen (alleen nodig als ACTIVE_STORAGE_PROVIDER = 'Nextcloud') ---
  NEXTCLOUD_USER: '',
  NEXTCLOUD_APP_PASSWORD: '', // <-- PLAK HIER JE WACHTWOORD

  // --- Google Drive Instellingen (alleen nodig als ACTIVE_STORAGE_PROVIDER = 'GoogleDrive') ---
  // Geen wachtwoord nodig; authenticatie gaat automatisch.

  // --- Dropbox Instellingen (voorbeeld voor toekomstige uitbreiding) ---
  // DROPBOX_ACCESS_TOKEN: 'JOUW_TOKEN_HIER'
};


/**
 * ===================================================================================
 * STAP 3: ALGEMENE CONFIGURATIE
 * Pas alle niet-gevoelige waarden in dit object aan.
 * ===================================================================================
 */
const USER_CONFIG_GENERAL = {

  // --- Test Modus ---
  // Dit is nu een VEILIGHEIDSSCHAKELAAR.
  // Indien true, weigert `runProduction()` te starten.
  // Je moet de speciale `runTest()` functie gebruiken.
  TEST_MODE: false,
  TEST_MODE_LABEL: 'test-gmail-cleanup',

  // --- Provider-Specifieke Instellingen ---
  
  NEXTCLOUD_CONFIG: {
    BASE_URL: 'https://nc.detussenpartij.nl',
    BASE_WEBDAV: 'https://nc.detussenpartij.nl/remote.php/dav/files/deeoonextcloud',
    ROOT_PATH: 'MailAttachments', // Map in Nextcloud
    USE_PUBLIC_LINKS: true,
    PUBLIC_LINK_EXPIRE_DAYS: 0, // 0 = Verloopt nooit
    PUBLIC_LINK_PASSWORD: ''    // '' = Geen wachtwoord
  },
  
  GOOGLE_DRIVE_CONFIG: {
    // Vervang dit door de ID van de Google Drive map waarin je wilt opslaan.
    // Je vindt de ID in de URL (bv. .../folders/DEZE_ID_CODE)
    ROOT_FOLDER_ID: 'JOUW_GOOGLE_DRIVE_MAP_ID_HIER'
  },

  // --- Gmail Zoekopdracht ---
  // Basis query wanneer *TEST_MODE false* is.
  // Het script voegt automatisch grootte (bv. `larger:100k`) en uitsluitingslabels toe.
  GMAIL_QUERY_BASE: 'has:attachment older_than:180d -in:spam -in:trash',

  // --- Bijlage Grootte Drempel ---
  // De enige bron voor bijlagegrootte (in KB).
  MIN_ATTACHMENT_SIZE_KB: 100,

  // --- Digest & Labels (Script maakt deze automatisch aan) ---
  DIGEST_SUBJECT_PREFIX: '[ARCHIVED-DIGEST]',
  PROCESSED_LABEL: 'Processed-Attachments',
  PROCESSING_LABEL: 'Processing-Attachment',
  PROCESSED_SKIPPED_LABEL: 'Processed-Skipped',
  PROCESSED_ERROR_LABEL: 'Processed-Error',

  // --- Performance & Limieten ---
  MAX_THREADS_PER_RUN: 30,
  EXECUTION_TIME_LIMIT_MINUTES: 5,
  SLEEP_AFTER_UPLOAD_MS: 1500,
  SLEEP_BETWEEN_THREADS_MS: 1000,

  // --- Overig ---
  INCLUDE_INLINE_IMAGES: false
};
// ===================================================================================
// EINDE CONFIGURATIE
// ===================================================================================


// --- Globale Constanten (Afgeleid) ---
// Combineer de algemene config met de config van de *actieve* provider
const CONFIG = {
  ...USER_CONFIG_GENERAL,
  ...USER_CONFIG_GENERAL[`${ACTIVE_STORAGE_PROVIDER.toUpperCase()}_CONFIG`],
  // Bereken de byte-drempel uit de KB-config
  SIZE_THRESHOLD_BYTES: USER_CONFIG_GENERAL.MIN_ATTACHMENT_SIZE_KB * 1024
};

/**
 * ===================================================================================
 * STEP 3: CREDENTIALS SETUP
 * Draai deze functie EENMALIG om je wachtwoorden veilig op te slaan.
 * ===================================================================================
 */
function setupCredentials() {
  const provider = getStorageProvider_();
  provider.initialize();
  Logger.log('Credentials successfully stored in PropertiesService.');
  Logger.log('VERGEET NIET je wachtwoord nu uit `USER_CONFIG_SENSITIVE` te verwijderen!');
}
