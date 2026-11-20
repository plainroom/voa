import type { SecurityType } from "@/services/imap/autoDiscovery";

export type ImapStep = "basic" | "imap" | "smtp" | "test";
export type ImapAuthMode = "password" | "oauth2";

export interface ImapFormState {
  email: string;
  displayName: string;
  imapUsername: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: SecurityType;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SecurityType;
  password: string;
  smtpPassword: string;
  samePassword: boolean;
  acceptInvalidCerts: boolean;
  authMode: ImapAuthMode;
  oauthProvider: string | null;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthAccessToken: string | null;
  oauthRefreshToken: string | null;
  oauthExpiresAt: number | null;
  oauthEmail: string | null;
}

export const initialImapForm: ImapFormState = {
  email: "",
  displayName: "",
  imapUsername: "",
  imapHost: "",
  imapPort: 993,
  imapSecurity: "ssl",
  smtpHost: "",
  smtpPort: 465,
  smtpSecurity: "ssl",
  password: "",
  smtpPassword: "",
  samePassword: true,
  acceptInvalidCerts: false,
  authMode: "password",
  oauthProvider: null,
  oauthClientId: "",
  oauthClientSecret: "",
  oauthAccessToken: null,
  oauthRefreshToken: null,
  oauthExpiresAt: null,
  oauthEmail: null,
};

export const imapSteps: ImapStep[] = ["basic", "imap", "smtp", "test"];

export const imapStepLabels: Record<ImapStep, string> = {
  basic: "Account",
  imap: "Incoming",
  smtp: "Outgoing",
  test: "Verify",
};

export interface ConnectionTest {
  state: "idle" | "testing" | "success" | "error";
  message?: string;
}

export const imapInputClass =
  "w-full px-3 py-2 bg-bg-secondary border border-border-primary rounded-lg text-sm text-text-primary outline-none focus:border-accent transition-colors";
export const imapLabelClass = "block text-xs font-medium text-text-secondary mb-1";
export const imapSelectClass =
  "w-full px-3 py-2 bg-bg-secondary border border-border-primary rounded-lg text-sm text-text-primary outline-none focus:border-accent transition-colors appearance-none";

/** Map the form's "ssl" onto the value the Rust commands expect. */
export function mapImapSecurity(security: string): string {
  if (security === "ssl") return "tls";
  return security;
}
