# Gmail Attachment Archiver to Cloud Storage

> **Reclaim Gmail space by automatically archiving large email attachments to Nextcloud or Google Drive**

[![Version](https://img.shields.io/badge/version-4.9.1-blue.svg)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Google Apps Script](https://img.shields.io/badge/platform-Google%20Apps%20Script-yellow.svg)](https://script.google.com)

This Google Apps Script automatically finds email threads with large attachments, uploads those attachments to cloud storage (Nextcloud or Google Drive), and replaces the original thread with a lightweight "digest" email containing direct download links.

## ⚠️ CRITICAL: BACKUP YOUR EMAIL FIRST

**This script PERMANENTLY DELETES original email threads** (moves them to trash). Before running in production:

### Option 1: Google Takeout (Recommended)
1. Go to [Google Takeout](https://takeout.google.com/)
2. **Deselect all** products
3. Select **ONLY "Mail"**
4. Choose format: `.mbox` (compatible with most email clients)
5. Click "Next step" → "Create export"
6. Download and **store the backup safely** (external drive recommended)

### Option 2: Secondary Gmail Address
1. Create a new Gmail account (e.g., `yourname.backup@gmail.com`)
2. In your main Gmail:
   - Go to **Settings** → **Forwarding and POP/IMAP**
   - Enable **POP download**
3. In your backup Gmail:
   - Go to **Settings** → **Accounts and Import**
   - Click **Add a mail account**
   - Enter your main email and import **all existing mail**
4. Wait for import to complete (may take hours/days for large mailboxes)

### Why This Matters
- Once a thread is trashed, recovery is **difficult** if something goes wrong
- Test mode only processes 1 thread - **not sufficient** to catch all edge cases
- Gmail's trash auto-deletes after 30 days

**Do not skip this step. Seriously.**

---

## 🚀 Features

- ✅ **Automatic Processing**: Batch processes hundreds of threads safely
- ✅ **Smart Deduplication**: Skips duplicate attachments within same thread AND across threads
- ✅ **Robust Error Handling**: Auto-recovers from rate limits and quota errors
- ✅ **Preserves Context**: Digest includes all original message content and labels
- ✅ **Read Status Matching**: Digest matches original thread's read/unread state
- ✅ **Multi-Provider Support**: Nextcloud or Google Drive (easily extensible)
- ✅ **Test Mode**: Safely test on labeled threads before processing everything
- ✅ **Preview Mode**: Dry run mode to see what would happen without making changes
- ✅ **Metrics Dashboard**: Track performance with beautiful web UI and detailed statistics
- ✅ **Progress Notifications**: Optional email updates after each batch completes
- ✅ **User-Friendly Errors**: Clear problem descriptions with step-by-step solutions
- ✅ **Emergency Rollback**: Restore archived threads from trash if needed
- ✅ **Smart Scheduling**: Optional time-window restrictions for processing
- ✅ **Configuration Validator**: Catches setup mistakes before they cause problems
- ✅ **Cleanup Tools**: Utilities for stuck labels and orphaned drafts

---

## 📋 How It Works

The script uses a **"Clean Sweep"** method:

1. **Finds** threads matching your criteria (e.g., `older_than:180d larger:100k`)
2. **Uploads** all large attachments to your chosen cloud storage
3. **Creates** a brand new digest email containing:
   - Direct download links to files in cloud storage
   - Complete chronological copy of original thread content
   - All original labels (except system labels)
4. **Cleans up** by moving the entire original thread to trash

**Result**: You get the same information, but without the large attachments eating Gmail quota.

---

## 🛠️ Setup Guide

### Prerequisites
- Google account with Gmail
- Nextcloud instance with WebDAV access **OR** Google Drive storage
- 10 minutes for initial setup

### Step 1: Create Google Apps Script Project

1. Go to [script.google.com](https://script.google.com)
2. Click **+ New Project**
3. Give it a name (e.g., "Gmail Attachment Archiver")
4. Delete the default `Code.gs` content

### Step 2: Add Script Files

1. **Create files** in the project (use the **+** icon):
   - `Config.gs`
   - `code.gs`
   - `Nextcloud_Connector`
   - `GoogleDrive_Connector`

2. **Copy contents** from this repository into each file

3. **Enable Gmail API**:
   - Click **Services** (+ icon in left sidebar)
   - Find **Gmail API** → Click **Add**

### Step 3: Configure Settings

Open `Config.gs` and edit the following sections:

#### Choose Your Storage Provider
```javascript
const ACTIVE_STORAGE_PROVIDER = 'Nextcloud';  // or 'GoogleDrive'
```

#### Nextcloud Configuration (if using Nextcloud)
```javascript
NEXTCLOUD_CONFIG: {
  BASE_URL: 'https://cloud.example.com',           // Your Nextcloud URL
  BASE_WEBDAV: 'https://cloud.example.com/remote.php/dav/files/username',
  ROOT_PATH: 'MailAttachments',                    // Folder to store files
  USE_PUBLIC_LINKS: true,
  PUBLIC_LINK_EXPIRE_DAYS: 0,                      // 0 = never expires
  PUBLIC_LINK_PASSWORD: ''                         // Leave empty for no password
}
```

#### Google Drive Configuration (if using Google Drive)
```javascript
GOOGLE_DRIVE_CONFIG: {
  ROOT_FOLDER_ID: 'YOUR_FOLDER_ID_HERE'  // Get from Drive folder URL
}
```

#### Gmail Query Settings
```javascript
// Adjust these to match your needs:
GMAIL_QUERY_BASE: 'has:attachment older_than:180d -in:spam -in:trash',
MIN_ATTACHMENT_SIZE_KB: 100,  // Only process attachments > 100KB
```

### Step 4: Store Credentials Securely

⚠️ **Important Security Step**

1. In `Config.gs`, **temporarily** fill in your credentials:
```javascript
const USER_CONFIG_SENSITIVE = {
  NEXTCLOUD_USER: 'your-username',
  NEXTCLOUD_APP_PASSWORD: 'your-app-password',  // ⚠️ Use app password, not main password!
};
```

2. In the Apps Script editor:
   - Select `setupCredentials` from the function dropdown
   - Click **Run** (▶️)
   - Authorize the script when prompted
   - Check logs - you should see "Credentials successfully stored"

3. **IMMEDIATELY delete your password** from `Config.gs`:
```javascript
const USER_CONFIG_SENSITIVE = {
  NEXTCLOUD_USER: 'your-username',
  NEXTCLOUD_APP_PASSWORD: 'XXX',  // ✅ Removed after setup
};
```

4. **Save** the file (Ctrl+S or Cmd+S)

**Why?** Credentials are now stored in Google's encrypted PropertiesService, not in plain text.

### Step 5: Test With One Thread

1. In Gmail, **manually apply** the label `test-gmail-cleanup` to 1-2 threads you want to test with
   - Choose threads with attachments
   - Preferably threads you don't mind losing (as backup)

2. In Apps Script editor:
   - Select `runTest` from function dropdown
   - Click **Run** (▶️)
   - Check logs (View → Logs)

3. **Verify results**:
   - Old thread should be in trash
   - New digest should be in archive with all labels
   - Files should be in Nextcloud/Drive
   - Download links should work

**If everything looks good, proceed to production. If not, debug before continuing.**

### Step 6: Run Production Mode

1. In `Config.gs`, **disable test mode**:
```javascript
TEST_MODE: false,  // ⚠️ Change this from true to false
```

2. Save the file

3. **Option A**: Manual runs
   - Select `runProduction` from function dropdown
   - Click **Run**
   - Script will process batches automatically and schedule itself to continue

4. **Option B**: Automatic hourly runs (recommended after testing)
   - Select `setupTriggerHourly` from function dropdown
   - Click **Run**
   - Script will now run every hour automatically

---

## ⚙️ Configuration Options

### Gmail Query Tuning

The `GMAIL_QUERY_BASE` uses Gmail search operators. Examples:

```javascript
// Process emails older than 6 months
'has:attachment older_than:180d -in:spam -in:trash'

// Only process emails from specific sender
'has:attachment from:oldcompany.com older_than:90d'

// Process specific label only
'has:attachment label:Archive -in:spam'
```

Script automatically adds:
- `larger:XXXk` based on `MIN_ATTACHMENT_SIZE_KB`
- Label exclusions (processed, processing, skipped, error)

### Performance Settings

```javascript
MAX_THREADS_PER_RUN: 30,              // Threads per batch
EXECUTION_TIME_LIMIT_MINUTES: 5,      // Stop before 6min timeout
SLEEP_AFTER_UPLOAD_MS: 1500,          // Wait after each upload batch
SLEEP_BETWEEN_THREADS_MS: 1000,       // Wait between threads
```

### Content Preservation

```javascript
MAX_BODY_CHARS: 10000,                // Truncate very long messages
MAX_INLINE_IMAGE_BYTES: 50000,        // Remove large base64 images
INCLUDE_INLINE_IMAGES: true,          // Process inline images as attachments
```

### Advanced Features (v4.9)

```javascript
PREVIEW_MODE: false,                  // Dry run without making changes
ENABLE_GLOBAL_DEDUPLICATION: true,    // Skip files uploaded in other threads
SEND_PROGRESS_EMAILS: false,          // Email notifications after each batch
PROCESSING_HOURS: null,               // Example: { START: 2, END: 6 } for 2 AM - 6 AM
```

---

## 🔧 Utility Functions

### View Metrics Dashboard

Track your archival progress with comprehensive statistics:

```javascript
// Run this from the script editor:
showMetrics()

// Or deploy as web app (Deploy → New deployment → Web app)
// Then access via the provided URL for a beautiful dashboard
```

Shows: threads processed/skipped/errored, files uploaded, space saved, duplicates skipped, success rate, and more.

### Validate Configuration

Before running in production, check your settings:

```javascript
// Run this from the script editor:
validateConfiguration()
```

Validates 15+ potential config issues including HTTPS requirements, numeric ranges, and provider settings.

### Preview Mode (Dry Run)

Test what would happen without making any changes:

```javascript
// In Config.gs, set:
PREVIEW_MODE: true

// Then run:
runProduction()
```

Logs all actions with `[PREVIEW]` prefix without uploading, deleting, or labeling anything.

### Emergency Rollback

Restore accidentally archived threads from trash:

```javascript
// Run this from the script editor:
emergencyRollback()
```

Moves up to 100 processed threads from trash back to inbox. Only works within Gmail's 30-day trash retention period.

### Reset Metrics

Start fresh with clean statistics:

```javascript
// Run this from the script editor:
resetMetrics()
```

Clears all tracked metrics (threads processed, files uploaded, etc.).

### Clean Up Orphaned Drafts

If an error occurs during digest creation, draft emails may be left behind:

```javascript
// Run this from the script editor:
cleanupOrphanedDrafts()
```

Safely deletes only drafts created by this script.

### Reset Stuck Processing Labels

If script crashes mid-run, threads may be stuck with "Processing-Attachment" label:

```javascript
// Run this from the script editor:
resetStuckProcessingLabels()
```

Removes processing label from all threads so they can be retried.

**Note:** Digest emails are automatically marked as read when archived (no manual action needed).

### Test Your Configuration

Before running on real threads:

```javascript
// Test Gmail query (shows what would be processed):
testQuery()

// Test storage provider upload:
testStorageProvider()
```

---

## 🐛 Troubleshooting

### Error: "Service invoked too many times"

**Cause**: Gmail has a limit of 100 emails sent per day per account.

**Solution**: Script automatically handles this. It will:
- Stop the current batch
- Keep the thread marked as "processing"
- Retry the next day when quota resets

### Error: "User-rate limit exceeded"

**Cause**: Too many API calls in short time.

**Solution**: Script automatically waits 15 minutes and retries.

### Error: "Email Body Size" or "Argument too large"

**Cause**: Thread has extremely long messages (e.g., 10,000-line HTML forwards).

**Solution**: Script automatically:
- Removes large base64 images
- Truncates messages longer than `MAX_BODY_CHARS`
- If still too large, thread is marked as error

Adjust in Config.gs:
```javascript
MAX_BODY_CHARS: 5000,  // Lower if you keep hitting limits
```

### Threads Stuck in "Processing-Attachment"

**Cause**: Script crashed mid-execution.

**Solution**:
```javascript
resetStuckProcessingLabels()
```

### Draft Emails Building Up

**Cause**: Digest creation failed after draft was created.

**Solution**:
```javascript
cleanupOrphanedDrafts()
```

### Files Not Uploading to Nextcloud

**Check**:
1. WebDAV path is correct (test in browser)
2. Nextcloud user has write permission to folder
3. App password is valid (not main password)
4. BASE_URL and BASE_WEBDAV use HTTPS

**Debug**:
```javascript
testStorageProvider()  // Check logs for detailed error
```

---

## 📊 Understanding Labels

The script creates and uses these labels automatically:

| Label | Meaning |
|-------|---------|
| `Processing-Attachment` | Currently being processed |
| `Processed-Attachments` | Successfully archived (on OLD thread in trash) |
| `Processed-Skipped` | No attachments met size criteria |
| `Processed-Error` | Permanent error occurred |
| `test-gmail-cleanup` | Test mode label (you create this) |

**Note**: Digest threads do NOT get processing labels. Your custom labels ARE copied to digest.

---

## 🔒 Security & Privacy

### What Gets Stored Where

- **Cloud Storage**: Attachments only
- **Gmail**: Digest emails with file links and original content
- **Script Properties** (encrypted): Nextcloud credentials
- **Not stored anywhere**: Script does not phone home or send analytics

### Credentials Security

- Never hardcode passwords in script after setup
- Use Nextcloud **app passwords**, not your main password
- Script properties are encrypted by Google (cannot be read in editor)

### HTTPS Enforcement

Script validates that Nextcloud URLs use HTTPS. HTTP connections are rejected.

---

## 🔄 How to Uninstall

1. **Disable triggers**:
   - In Apps Script: Edit → Current project's triggers
   - Delete all triggers

2. **Remove labels** (optional):
   - In Gmail, manually delete: `Processed-Attachments`, `Processing-Attachment`, etc.

3. **Restore threads from trash** (if needed):
   - In Gmail trash, select threads
   - Click "Move to inbox"

4. **Delete script**:
   - In Apps Script: File → Delete project

**Note**: Files in cloud storage are NOT deleted. Remove manually if needed.

---

## 📈 Performance Expectations

Typical performance (v4.8):

- **Processing speed**: ~2-3 threads per minute
- **Daily limit**: 100 threads (Gmail sending quota)
- **Large mailboxes**: 10GB of attachments ≈ 2-3 weeks to fully process

**Calculation for your mailbox**:
```
Days needed = (threads to process) / (100 threads/day)
```

**Example**: 5,000 threads with attachments → ~50 days of automatic hourly runs

---

## 🤝 Contributing

Contributions are welcome! To contribute:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly in test mode
5. Submit a pull request

Please include:
- Description of the change
- Testing methodology
- Any new configuration options

---

## 📄 License

MIT License - See [LICENSE](LICENSE) file for details.

**TL;DR**: Free to use, modify, and distribute. No warranty provided.

---

## 🙏 Credits

- **Original Development**: Built with assistance from Google Gemini
- **v4.8 Optimization & Review**: Claude (Anthropic)
- **v4.9 Enhancement**: Advanced features and observability by Claude (Anthropic)
- **Testing**: Community contributors

---

## 📞 Support

- **Bug Reports**: [GitHub Issues](https://github.com/yourusername/archive-gmail-attachments-to-nextcloud/issues)
- **Questions**: [GitHub Discussions](https://github.com/yourusername/archive-gmail-attachments-to-nextcloud/discussions)
- **Feature Requests**: [GitHub Issues](https://github.com/yourusername/archive-gmail-attachments-to-nextcloud/issues) with `enhancement` label

---

## ⚡ Quick Start Checklist

- [ ] Backed up Gmail via Takeout or secondary account
- [ ] Created Apps Script project
- [ ] Added all 4 script files
- [ ] Enabled Gmail API
- [ ] Configured `Config.gs` with storage provider details
- [ ] Ran `setupCredentials()` and removed password from code
- [ ] Tested with 1-2 threads using `runTest()`
- [ ] Verified digest looks correct and files are accessible
- [ ] Set `TEST_MODE: false`
- [ ] Ran `runProduction()` or set up hourly trigger
- [ ] Monitored first few batches in logs

**Happy archiving! 🎉**
