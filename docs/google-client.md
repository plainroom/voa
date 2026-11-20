# Create a Google client for voa

voa talks to Gmail with an OAuth client that you own, in your own Google Cloud project. Nobody else's quota, no voa server in between. You do this once; it takes about ten minutes and costs nothing.

Google changes its console now and then. If a label below does not match what you see, look for the closest one: the steps and the values to enter stay the same.

## 1. Create a project

1. Open the [Google Cloud console](https://console.cloud.google.com/) and sign in with the Google account that will own the project (it does not have to be one of the mailboxes you read).
2. Click the project picker at the top, then **New project**. Name it `voa`. Leave the organization as it is. **Create**, and select the new project.

## 2. Enable the Gmail API

1. Open **APIs & Services**, **Library**.
2. Search for **Gmail API**, open it and click **Enable**.

## 3. Set up the consent screen

This is what Google shows when you sign a mailbox in. In the console it lives under **Google Auth Platform** (older consoles: **APIs & Services**, **OAuth consent screen**).

1. Open **Google Auth Platform** and click **Get started**.
2. **App information:** app name `voa`, user support email: yours. Next.
3. **Audience:** choose **External**. Next.
4. **Contact information:** your email. Next. Accept the policy and **Create**.
5. Open **Data Access**, **Add or remove scopes**, and add these (paste them into the "Manually add scopes" box if you cannot find them in the list):

   ```
   https://www.googleapis.com/auth/gmail.modify
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/gmail.send
   https://www.googleapis.com/auth/gmail.labels
   https://www.googleapis.com/auth/userinfo.email
   https://www.googleapis.com/auth/userinfo.profile
   ```

   **Update**, then **Save**. `gmail.modify` is what lets voa archive, star and remind; `gmail.send` is for sending.
6. Open **Audience** and click **Publish app**, then **Confirm**. The status must read **In production**.

Do not leave the app in **Testing**: Google signs you out of a testing app every 7 days, and you would have to reconnect each week.

## 4. Create the client

1. Open **Google Auth Platform**, **Clients** (older consoles: **APIs & Services**, **Credentials**, **Create credentials**, **OAuth client ID**).
2. **Create client**. Application type: **Desktop app**. Name: `voa`. **Create**.
3. Google shows the **Client ID** (it ends in `.apps.googleusercontent.com`) and the **Client secret**. Copy both. You can open the client again later to see them.

A desktop client needs no redirect address: Google accepts the local one voa uses (`http://127.0.0.1:17248`).

## 5. Put it in voa

1. Open voa, press `,` (or click the gear at the top right).
2. Under **Google client**, paste the **Client ID** and the **Client secret**. **Save**.
3. Click **Add account**, choose **Google (Gmail)** and **Sign in with Google**. Your browser opens.

## The "Google hasn't verified this app" screen

The first time you sign in, Google shows a warning because nobody has submitted your project for Google's review. That is expected: you are the author and the user.

1. Click **Advanced**.
2. Click **Go to voa (unsafe)**.
3. Tick every permission box and **Continue**.

You see this once per Google account you connect.

Two limits come with an unverified app:

- **100 users.** Only 100 different Google accounts can ever connect to it. For your own mailboxes that is plenty. Going past it means submitting the app to Google for verification, which for Gmail's modify scope includes a security assessment; voa is not meant for that.
- **The warning screen stays.** It never goes away without verification.

## If sign-in fails

- **"Client ID not configured" or "Client Secret is not configured":** both fields in Settings must be filled and saved.
- **"Access blocked: voa has not completed the Google verification process" / error 403 access_denied:** the app is still in **Testing**. Publish it (step 3.6), or add your address under **Audience**, **Test users**.
- **"Google did not return a refresh token":** open [your Google account's third-party access page](https://myaccount.google.com/permissions), remove voa and sign in again.
- **Port 17248 busy:** another program (or a second voa) holds it. Close it and retry.
- **A mailbox that worked stops syncing:** Settings, **Reconnect** beside it.

## Without Google Cloud: an app password

If you would rather not create a project, a Gmail mailbox also works over IMAP with an app password.

1. In your Google account, [turn on 2-Step Verification](https://myaccount.google.com/signinoptions/two-step-verification) if it is off.
2. Open [App passwords](https://myaccount.google.com/apppasswords), name it `voa` and **Create**. Copy the 16 letters.
3. In voa: Settings, **Add account**, **IMAP / SMTP**. Enter your Gmail address and the app password (not your normal password). voa does not know Gmail's servers on this path, so enter them: IMAP `imap.gmail.com` port 993, SMTP `smtp.gmail.com` port 465, both with SSL/TLS.

The same screen connects any other provider (iCloud, Fastmail, your own server). A personal Outlook or Hotmail account has its own button there and does not use IMAP.
