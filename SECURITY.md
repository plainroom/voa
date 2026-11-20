# Security Policy

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private security advisory for this repository ("Report a vulnerability" under the Security tab).

Include what you found, how to reproduce it and what it could do. You should hear back within a week.

## What voa stores and where

voa is a desktop application. Your mail, tokens and settings live in a local SQLite database on your machine. There is no voa server.

- **Gmail and Outlook:** you sign in with your own OAuth client (see docs/google-client.md and docs/microsoft-client.md). Tokens are stored in the local database, encrypted with a key kept in the app data folder.
- **IMAP accounts:** passwords are stored encrypted (AES-256-GCM) in the local database.
- **Mail content:** HTML is sanitized (DOMPurify) and rendered in a sandboxed iframe that runs no script and cannot navigate the app; only http, https and mailto links survive, and they open in your browser. Remote images load by default (Settings > Block remote images turns that off); in Spam they never load by themselves.
- **Network:** voa talks only to your mail providers (Google, your IMAP/SMTP servers, Microsoft and Yahoo for their OAuth sign-ins).

## Scope

In scope: the voa code in this repository. Out of scope: your mail provider, and issues in dependencies with no demonstrated impact on voa.
