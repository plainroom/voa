# Create a Microsoft client for voa

voa reads a personal Outlook, Hotmail or Live mailbox through Microsoft Graph, with an app registration that you own. It is a public client: there is no secret to keep. You do this once; it takes about five minutes and costs nothing.

Microsoft changes its portal now and then. If a label below does not match what you see, look for the closest one: the values to enter stay the same.

## 1. Register the app

1. Open [App registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) in the Microsoft Entra admin center and sign in with any Microsoft account (it does not have to be the mailbox you read).
2. **New registration**.
   - **Name:** `voa`.
   - **Supported account types:** *Personal Microsoft accounts only*.
   - **Redirect URI:** platform *Public client/native (mobile & desktop)*, value `http://localhost`.
3. **Register**.

## 2. Check the permissions

voa asks for these when you sign in, so nothing has to be added by hand. Under **API permissions** you can see them after the first sign-in:

- `User.Read`: your name and address.
- `Mail.ReadWrite`: read the mail, archive, star, move to Trash or Junk.
- `Mail.Send`: send what you write.
- `offline_access`: stay signed in.

## 3. Give voa the client ID

1. On the app's **Overview**, copy the **Application (client) ID**.
2. In voa, open Settings (`,`), paste it under **Microsoft** and save.
3. **Add account**, **Outlook**. The browser opens Microsoft's sign-in; after it, the mailbox syncs.

The client ID is kept only in voa's local database on your machine.

## Work or school accounts

They are not supported: voa signs in through Microsoft's endpoint for personal accounts only. A work account usually needs its administrator to allow the app; use IMAP / SMTP if your organization offers it.
