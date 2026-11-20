import { useState } from "react";
import { Mail } from "lucide-react";
import { startOAuthFlow } from "@/services/gmail/auth";
import { connectGraphAccount } from "@/services/graph/auth";
import { insertAccount } from "@/services/db/accounts";
import { getClientId, getClientSecret } from "@/services/gmail/tokenManager";
import { getSetting } from "@/services/db/settings";
import { useAccountStore } from "@/stores/accountStore";
import { Modal } from "@/voa/ui/Modal";
import { SetupClientId } from "./SetupClientId";
import { AddImapAccount } from "./AddImapAccount";
import { getCurrentUnixTimestamp } from "@/utils/timestamp";

interface AddAccountProps {
  onClose: () => void;
  onSuccess: () => void;
}

type View = "select-provider" | "gmail" | "outlook" | "imap";

export function AddAccount({ onClose, onSuccess }: AddAccountProps) {
  const [view, setView] = useState<View>("select-provider");
  const [status, setStatus] = useState<
    "idle" | "checking" | "authenticating" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const addAccount = useAccountStore((s) => s.addAccount);

  const showProviders = () => {
    setView("select-provider");
    setStatus("idle");
    setError(null);
  };

  const handleAddGmailAccount = async () => {
    setStatus("checking");
    setError(null);

    try {
      const clientId = await getClientId();
      const clientSecret = await getClientSecret();
      setStatus("authenticating");

      const { tokens, userInfo } = await startOAuthFlow(clientId, clientSecret);

      const accountId = crypto.randomUUID();
      const expiresAt = getCurrentUnixTimestamp() + tokens.expires_in;

      await insertAccount({
        id: accountId,
        email: userInfo.email,
        displayName: userInfo.name,
        avatarUrl: userInfo.picture,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? "",
        tokenExpiresAt: expiresAt,
      });

      addAccount({
        id: accountId,
        email: userInfo.email,
        displayName: userInfo.name,
        avatarUrl: userInfo.picture,
        isActive: true,
      });

      onSuccess();
    } catch (err) {
      console.error("Add account error:", err);
      const message =
        err instanceof Error ? err.message : String(err);
      if (message.includes("Client ID not configured")) {
        setNeedsSetup(true);
      } else {
        setError(message);
        setStatus("error");
      }
    }
  };

  const handleAddOutlookAccount = async () => {
    setStatus("checking");
    setError(null);
    try {
      const clientId = (await getSetting("microsoft_client_id")) ?? "";
      setStatus("authenticating");
      await connectGraphAccount(clientId);
      onSuccess();
    } catch (err) {
      console.error("Add Outlook account error:", err);
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  if (needsSetup) {
    return (
      <SetupClientId
        onComplete={() => {
          setNeedsSetup(false);
          setStatus("idle");
        }}
        onCancel={onClose}
      />
    );
  }

  if (view === "imap") {
    return (
      <AddImapAccount
        onClose={onClose}
        onSuccess={onSuccess}
        onBack={() => setView("select-provider")}
      />
    );
  }

  if (view === "gmail") {
    return (
      <OAuthSignIn
        title="Add Gmail Account"
        intro="Sign in with your Google account to connect it to voa."
        waiting="Waiting for Google sign-in..."
        action="Sign in with Google"
        status={status}
        error={error}
        onBack={showProviders}
        onClose={onClose}
        onSignIn={handleAddGmailAccount}
      />
    );
  }

  if (view === "outlook") {
    return (
      <OAuthSignIn
        title="Add Outlook Account"
        intro="Sign in with the personal Outlook or Hotmail account you want in voa."
        waiting="Waiting for Microsoft sign-in..."
        action="Sign in with Microsoft"
        status={status}
        error={error}
        onBack={showProviders}
        onClose={onClose}
        onSignIn={handleAddOutlookAccount}
      />
    );
  }

  // Provider selection view
  return (
    <Modal isOpen={true} onClose={onClose} title="Add Account" width="w-full max-w-md">
      <div className="p-4">
        <p className="text-text-secondary text-sm mb-4">
          Choose how you want to connect your email account.
        </p>

        <div className="space-y-3">
          <button
            onClick={() => setView("gmail")}
            className="w-full flex items-center gap-4 p-4 rounded-lg border border-border-primary bg-bg-secondary hover:bg-bg-hover transition-colors text-left group"
          >
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-bg-tertiary flex items-center justify-center">
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">
                Google (Gmail)
              </div>
              <div className="text-xs text-text-tertiary mt-0.5">
                Connect via OAuth with full Gmail API support
              </div>
            </div>
          </button>

          <button
            onClick={() => setView("outlook")}
            className="w-full flex items-center gap-4 p-4 rounded-lg border border-border-primary bg-bg-secondary hover:bg-bg-hover transition-colors text-left group"
          >
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-bg-tertiary flex items-center justify-center">
              <OutlookMark />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">
                Outlook (Hotmail)
              </div>
              <div className="text-xs text-text-tertiary mt-0.5">
                Connect a personal Outlook or Hotmail account
              </div>
            </div>
          </button>

          <button
            onClick={() => setView("imap")}
            className="w-full flex items-center gap-4 p-4 rounded-lg border border-border-primary bg-bg-secondary hover:bg-bg-hover transition-colors text-left group"
          >
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-bg-tertiary flex items-center justify-center">
              <Mail className="w-5 h-5 text-text-secondary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">
                IMAP / SMTP
              </div>
              <div className="text-xs text-text-tertiary mt-0.5">
                Connect any email provider with manual server configuration
              </div>
            </div>
          </button>
        </div>

        <div className="flex justify-end mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The Outlook mark, at the same size as the Google mark on the button above. */
function OutlookMark() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 1831.085 1703.335" aria-hidden="true">
      <path fill="#0A2767" d="M1831.083,894.25c0.1-14.318-7.298-27.644-19.503-35.131h-0.213l-0.767-0.426l-634.492-375.585c-2.74-1.851-5.583-3.543-8.517-5.067c-24.498-12.639-53.599-12.639-78.098,0c-2.934,1.525-5.777,3.216-8.517,5.067L446.486,858.693l-0.766,0.426c-19.392,12.059-25.337,37.556-13.278,56.948c3.553,5.714,8.447,10.474,14.257,13.868l634.492,375.585c2.749,1.835,5.592,3.527,8.517,5.068c24.498,12.639,53.599,12.639,78.098,0c2.925-1.541,5.767-3.232,8.517-5.068l634.492-375.585C1823.49,922.545,1831.228,908.923,1831.083,894.25z" />
      <path fill="#0364B8" d="M520.453,643.477h416.38v381.674h-416.38V643.477z M1745.917,255.5V80.908c1-43.652-33.552-79.862-77.203-80.908H588.204C544.552,1.046,510,37.256,511,80.908V255.5l638.75,170.333L1745.917,255.5z" />
      <path fill="#0078D4" d="M511,255.5h425.833v383.25H511V255.5z" />
      <path fill="#28A8EA" d="M1362.667,255.5H936.833v383.25L1362.667,1022h383.25V638.75L1362.667,255.5z" />
      <path fill="#0078D4" d="M936.833,638.75h425.833V1022H936.833V638.75z" />
      <path fill="#0364B8" d="M936.833,1022h425.833v383.25H936.833V1022z" />
      <path fill="#14447D" d="M520.453,1025.151h416.38v346.969h-416.38V1025.151z" />
      <path fill="#0078D4" d="M1362.667,1022h383.25v383.25h-383.25V1022z" />
      <path fill="#1490DF" d="M1811.58,927.593l-0.809,0.468l-634.492,356.848c-2.768,1.703-5.578,3.321-8.517,4.769c-24.641,12.038-53.457,12.038-78.098,0c-2.918-1.445-5.76-3.037-8.517-4.769L446.657,928.061l-0.766-0.468c-12.25-6.642-19.93-19.409-20.057-33.343v722.384c0.305,48.188,39.616,87.004,87.803,86.7h1229.636c48.188,0.307,87.5-38.509,87.807-86.696V894.25C1831.068,908.067,1823.616,920.807,1811.58,927.593z" />
      <path fill="#28A8EA" d="M514.833,1703.333h1228.316c18.901,0.096,37.335-5.874,52.59-17.033l-697.089-408.331c-2.929-1.47-5.773-3.105-8.517-4.897L447.125,906.088h-0.298l-20.993-11.838v719.914C425.786,1663.364,465.632,1703.286,514.833,1703.333z" />
      <path fill="#0A63C9" d="M78.055,383.25h780.723c43.109,0,78.055,34.947,78.055,78.055v780.723c0,43.109-34.946,78.055-78.055,78.055H78.055c-43.109,0-78.055-34.947-78.055-78.055V461.305C0,418.197,34.947,383.25,78.055,383.25z" />
      <path fill="#FFFFFF" d="M243.96,710.631c19.238-40.988,50.29-75.289,89.17-98.495c43.057-24.651,92.081-36.94,141.675-35.515c45.965-0.997,91.321,10.655,131.114,33.683c37.414,22.312,67.547,55.004,86.742,94.109c20.904,43.09,31.322,90.512,30.405,138.396c1.013,50.043-9.706,99.628-31.299,144.783c-19.652,40.503-50.741,74.36-89.425,97.388c-41.327,23.734-88.367,35.692-136.011,34.578c-46.947,1.133-93.303-10.651-134.01-34.067c-37.738-22.341-68.249-55.07-87.892-94.28c-21.028-42.467-31.57-89.355-30.745-136.735C212.808,804.859,223.158,755.686,243.96,710.631z M339.006,941.858c10.257,25.912,27.651,48.385,50.163,64.812c22.93,16.026,50.387,24.294,78.353,23.591c29.783,1.178,59.14-7.372,83.634-24.358c22.227-16.375,39.164-38.909,48.715-64.812c10.677-28.928,15.946-59.572,15.543-90.404c0.33-31.127-4.623-62.084-14.649-91.554c-8.855-26.607-25.246-50.069-47.182-67.537c-23.88-17.79-53.158-26.813-82.91-25.55c-28.572-0.74-56.644,7.593-80.184,23.804c-22.893,16.496-40.617,39.168-51.1,65.365c-23.255,60.049-23.376,126.595-0.341,186.728L339.006,941.858z" />
      <path fill="#50D9FF" d="M1362.667,255.5h383.25v383.25h-383.25V255.5z" />
    </svg>
  );
}

function OAuthSignIn({
  title,
  intro,
  waiting,
  action,
  status,
  error,
  onBack,
  onClose,
  onSignIn,
}: {
  title: string;
  intro: string;
  waiting: string;
  action: string;
  status: "idle" | "checking" | "authenticating" | "error";
  error: string | null;
  onBack: () => void;
  onClose: () => void;
  onSignIn: () => void;
}) {
  const busy = status === "authenticating" || status === "checking";
  return (
    <Modal isOpen={true} onClose={onClose} title={title} width="w-full max-w-md">
      <div className="p-4">
        <p className="text-text-secondary text-sm mb-6">{intro}</p>
        {error && <div className="bg-danger/10 border border-danger/20 rounded-lg p-3 mb-4 text-sm text-danger">{error}</div>}
        {status === "authenticating" && (
          <div className="text-center py-4 text-text-secondary text-sm">
            <div className="mb-2">{waiting}</div>
            <div className="text-xs text-text-tertiary">Complete the sign-in in your browser, then return here.</div>
          </div>
        )}
        <div className="flex gap-3 justify-between">
          <button onClick={onBack} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">
            Back
          </button>
          <div className="flex gap-3">
            <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">
              Cancel
            </button>
            <button
              onClick={onSignIn}
              disabled={busy}
              className="px-4 py-2 text-sm bg-ink text-canvas rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {status === "authenticating" ? "Waiting..." : status === "checking" ? "Checking..." : action}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
