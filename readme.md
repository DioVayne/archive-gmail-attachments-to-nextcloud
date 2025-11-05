Gmail-to-Nextcloud Archiver
===========================

This Google Apps Script helps you reclaim space in your Gmail account by finding email threads with large attachments, uploading those attachments to a Nextcloud server, and replacing the original email thread with a lightweight "digest" email.

This script uses a **"Clean Sweep"** method:

1.  **Finds** a thread (e.g., `older_than:180d larger:1M`).

2.  **Uploads** all attachments from the thread to Nextcloud.

3.  **Creates** a *brand new, separate* digest email containing:

    -   Direct download links to the files on Nextcloud.

    -   A full, chronological summary of the original thread's content.

4.  **Cleans Up** by moving the *entire original thread* to the Trash and applying a `Processed-Attachments` label to it.

This ensures a clean separation, archives your data, and frees up your Gmail quota.

Features
--------

-   **Secure:** Uses Google's `PropertiesService` to store your Nextcloud App Password securely, not in plain text.

-   **Robust:** Uses a `createDraft().send()` method to reliably find the new digest mail, avoiding race conditions.

-   **Efficient:** Processes threads in a single pass (O(N)) to gather attachments and message bodies simultaneously.

-   **Safe Testing:** Includes a dedicated `runTest()` function that *only* processes threads you've manually labeled, so you can test safely before processing your entire backlog.

-   **Resilient:** Built to run in batches, automatically pausing and resuming to respect Google's execution time limits (6 min).

Setup Guide
-----------

### Step 1: Prepare Google Apps Script

1.  Create a new Google Apps Script project at [script.google.com](https://script.google.com "null").

2.  Copy the full contents of `gmail_to_nextcloud_archiver.gs` into the `Code.gs` file in the editor.

3.  **Enable the Gmail API:**

    -   In the editor, go to **Services** (the `+` icon on the left).

    -   Find **Gmail API** in the list, and click **Add**.

### Step 2: Configure the Script

At the top of the `gmail_to_nextcloud_archiver.gs` file, you will find two configuration objects.

1.  **`USER_CONFIG_SENSITIVE` (Lines 80-83):**

    -   Fill in your `NEXTCLOUD_USER` and `NEXTCLOUD_APP_PASSWORD`.

    -   **Note:** This is a *temporary* step. You will delete the password in Step 3.

2.  **`USER_CONFIG_GENERAL` (Lines 93-162):**

    -   Fill in your Nextcloud URLs (`NEXTCLOUD_BASE_URL`, `NEXTCLOUD_BASE_WEBDAV`, `ROOT_PATH`).

    -   Configure your `GMAIL_QUERY_BASE`. This is what the script will search for when in production mode (e.g., `has:attachment older_than:365d`).

    -   Set `MIN_ATTACHMENT_SIZE_KB` (e.g., `1024` for 1MB). The script automatically builds the `larger:1m` query from this.

    -   Review the label names. The script will **auto-create** these labels if they don't exist.

### Step 3: Secure Your Credentials (Run Once)

This is a critical step to protect your Nextcloud password.

1.  In the Apps Script editor, select the `setupCredentials` function from the dropdown menu at the top.

2.  Click **Run**.

3.  Check the logs. You should see `Credentials successfully stored...`.

4.  **IMPORTANT:** Go back to the `USER_CONFIG_SENSITIVE` block (Step 2.1) and **delete your plain-text password**. The script will now read it from secure storage.

### Step 4: Run the Script

The script has two modes: Test and Production.

#### 1\. Test Mode (Recommended First)

This mode is active by default (`TEST_MODE: true`). It will *only* process threads that you manually label.

1.  Go to Gmail and find one or two threads you want to test.

2.  Apply the label `test-gmail-cleanup` to them (or whatever label you defined in `TEST_MODE_LABEL`).

3.  In the Apps Script editor, select the **`runTest`** function.

4.  Click **Run**.

5.  The script will process **one** of the labeled threads. Check your Gmail (Inbox, Archive, and Trash) and Nextcloud to confirm it worked as expected.

#### 2\. Production Mode

Once you are satisfied with the tests:

1.  In the `USER_CONFIG_GENERAL` block, set **`TEST_MODE: false`**.

2.  Save the script.

3.  In the Apps Script editor, select the **`runProduction`** function.

4.  Click **Run**.

The script will now start processing your *entire* backlog based on your `GMAIL_QUERY_BASE`. It will run in 5-minute batches and automatically schedule itself to continue until the entire backlog is cleared.

### Step 5: Automate (Optional)

After you have run the script in production and are happy with the results, you can set it to run automatically every hour to catch new emails.

1.  In the Apps Script editor, select the **`setupTriggerHourly`** function.

2.  Click **Run**.

3.  This will create a new time-based trigger that runs `runProduction` every hour.

Debugging
---------

You can use the helper functions (at the bottom of the script) for debugging:

-   **`testQuery()`:** Runs the *exact* query that `runTest` or `runProduction` would use (depending on your `TEST_MODE` setting) and logs the first 20 threads it finds. This is great for testing your query logic without processing anything.

-   **`testFlatPut()`:** Performs a simple "hello.txt" upload to your Nextcloud server. Use this if you get "Upload Failed" errors to check if your credentials and WebDAV path are correct.
