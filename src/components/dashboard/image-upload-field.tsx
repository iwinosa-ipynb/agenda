"use client";

import { useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

import { Avatar } from "@/components/dashboard/avatar";
import { buttonClasses, Button } from "@/components/ui/button";
import {
  isAllowedProfilePhotoContentType,
  isWithinProfilePhotoSize,
  PROFILE_PHOTO_MAX_BYTES,
} from "@/lib/profile-photo";
import { cn } from "@/lib/utils";

/* ══════════════════════════════════════════════════════════════════════
   TEMPORARY VISIBLE DIAGNOSTICS — remove after the real iPhone test.
   State lives at MODULE scope so it survives re-renders AND remounts
   (a remount would otherwise wipe the evidence we are hunting for).
   ══════════════════════════════════════════════════════════════════════ */

type DiagStatus = "ok" | "err" | "idle";

interface DiagEntry {
  status: DiagStatus;
  detail: string;
  time: string;
}

const DIAG_ORDER = [
  "MODULE",
  "MOUNT",
  "LISTENER",
  "CLICK",
  "CHANGE",
  "HANDLE",
  "FILE",
  "VALIDATION",
  "PENDING",
  "UPLOAD",
  "SERVER",
  "SUCCESS",
  "ERROR",
] as const;

type DiagKey = (typeof DIAG_ORDER)[number];

const DIAG_ENTRIES: Partial<Record<DiagKey, DiagEntry>> = {};
const DIAG_SUBS = new Set<() => void>();
let DIAG_MOUNTS = 0;

function diagNow(): string {
  const d = new Date();
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function setDiag(key: DiagKey, status: DiagStatus, detail: string): void {
  DIAG_ENTRIES[key] = { status, detail, time: diagNow() };
  DIAG_SUBS.forEach((notify) => notify());
}

function resetDiagnostics(): void {
  for (const key of DIAG_ORDER) {
    delete DIAG_ENTRIES[key];
  }
  setDiag("MODULE", "ok", "RESET pressed — component bundle is loaded");
}

/** Subscribe the component to diagnostic-store updates. */
function useDiagTick(): void {
  const [, setTick] = useState(0);

  useEffect(() => {
    const notify = () => setTick((tick) => tick + 1);
    DIAG_SUBS.add(notify);
    return () => {
      DIAG_SUBS.delete(notify);
    };
  }, []);
}

/**
 * Stamp a DOM node once so the panel can prove whether the listener is on
 * the SAME input element the user actually interacts with.
 */
function diagTag(el: HTMLInputElement | null): string {
  const tagged = el as unknown as { __diagId?: string } | null;
  if (tagged && !tagged.__diagId) {
    tagged.__diagId = `E${Math.random().toString(36).slice(2, 7)}`;
  }
  return tagged ? (tagged.__diagId ?? "?") : "null";
}

/**
 * Diagnostic-only reachability probe. `upload()` does not expose the token
 * response headers to its caller, so this asks the same route directly and
 * reads back the temporary `x-diag-server` header. Sends no file bytes, no
 * tokens, and nothing sensitive.
 */
async function probeServer(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "diag-probe" }),
      cache: "no-store",
    });
    const header = res.headers.get("x-diag-server");
    return {
      ok: header === "reached",
      detail: header
        ? `reached — HTTP ${res.status}, x-diag-server: ${header}`
        : `HTTP ${res.status} but NO x-diag-server header`,
    };
  } catch (probeError) {
    return {
      ok: false,
      detail: `unreachable — ${
        probeError instanceof Error ? probeError.message : String(probeError)
      }`,
    };
  }
}

// Fires at bundle evaluation: proves the diagnostic JS actually loaded.
setDiag("MODULE", "ok", "component bundle evaluated");

/** Visible panel — deliberately loud so it cannot be missed on a phone. */
function DiagPanel() {
  return (
    <div className="overflow-hidden rounded-xl border-4 border-red-600 bg-amber-50 shadow-2xl">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-red-600 px-3 py-2">
        <p className="text-xs font-black uppercase tracking-wider text-white">
          ⚠ Upload diagnostics (temporary)
        </p>
        <button
          type="button"
          onClick={resetDiagnostics}
          className="rounded-md border-2 border-white bg-white px-3 py-1.5 text-xs font-black uppercase text-red-700 active:bg-red-100"
        >
          Reset diagnostics
        </button>
      </div>

      <ol className="divide-y divide-amber-200 px-2 py-1">
        {DIAG_ORDER.map((key, index) => {
          const entry = DIAG_ENTRIES[key];
          const status: DiagStatus = entry?.status ?? "idle";

          return (
            <li
              key={key}
              className={cn(
                "px-1 py-1.5 font-mono text-[11px] leading-tight",
                status === "ok" && "text-green-800",
                status === "err" && "text-red-700",
                status === "idle" && "text-gray-400",
              )}
            >
              <div className="flex items-baseline gap-2">
                <span className="w-3 shrink-0 text-sm font-black">
                  {status === "ok" ? "✓" : status === "err" ? "✗" : "·"}
                </span>
                <span className="shrink-0 font-black text-gray-700">
                  {index + 1}.
                </span>
                <span className="shrink-0 font-black uppercase text-gray-900">
                  {key}
                </span>
                <span className="ml-auto shrink-0 text-gray-500">
                  {entry?.time ?? ""}
                </span>
              </div>
              <div className="ml-5 break-words">
                {entry ? entry.detail : "not reached"}
              </div>
            </li>
          );
        })}
      </ol>

      <p className="border-t-2 border-red-600 bg-red-50 px-3 py-1.5 font-mono text-[10px] leading-snug text-red-800">
        mounts: {DIAG_MOUNTS} · state persists across re-renders and remounts ·
        clears only on RESET or full page reload
      </p>
    </div>
  );
}
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * Shared image uploader for Vercel Blob client uploads — used by the creator
 * profile photo AND the advertiser logo, so both flows have the identical UX:
 * Upload / Replace / Remove, live preview, initials fallback.
 *
 * The selected file uploads straight from the browser to Blob storage via the
 * flow's authenticated token route — it never passes through a large Next.js
 * server request. On success the resulting public URL is written into a
 * hidden input named `fieldName` and persisted by the form's normal save. No
 * URL is ever written to the database by this component itself, so a failed
 * upload cannot store a bad value.
 *
 * The `accept` list includes HEIC/HEIF because phones (iPhones by default)
 * hand the picker those types; the picker-level acceptance exists purely so
 * users can COMPLETE the selection and see a specific message instead of a
 * silently dead control. Server-side validation still enforces the JPEG/PNG/
 * WebP allow-list (those files are rejected with explicit guidance).
 */
export function ImageUploadField({
  fieldName,
  label,
  entityName,
  initialUrl,
  handleUploadUrl,
  uploadPrefix,
  acceptHint = "JPG, PNG or WebP, up to 4 MB.",
  error,
}: {
  /** Hidden-input name the surrounding form persists (e.g. profileImage/logoUrl). */
  fieldName: string;
  label: string;
  /** Display name used for the initials fallback avatar. */
  entityName: string;
  initialUrl: string | null;
  /** Authenticated token route for this flow. */
  handleUploadUrl: string;
  /** Storage prefix this flow owns (client-side path prefix). */
  uploadPrefix: string;
  acceptHint?: string;
  error?: string;
}) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [pending, setPending] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Re-render the panel whenever a checkpoint is recorded.
  useDiagTick();

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    setDiag("HANDLE", "ok", "handleFile invoked by native change listener");

    const file = event.target.files?.[0];
    const filesLength = event.target.files?.length ?? 0;

    // Allow re-selecting the same file after a failure.
    event.target.value = "";

    if (!file) {
      setDiag(
        "FILE",
        "err",
        `NO FILE — files.length=${filesLength} (silent early return, no message shown)`,
      );
      setDiag(
        "ERROR",
        "err",
        `files[0] was undefined (files.length=${filesLength})`,
      );
      setDiag("SERVER", "idle", "not attempted — stopped before any request");
      return;
    }

    setDiag(
      "FILE",
      "ok",
      `name=${file.name} · type=${file.type || "(empty)"} · size=${file.size} bytes`,
    );

    setUploadError(null);

    const typeAllowed = isAllowedProfilePhotoContentType(file.type);
    const sizeAllowed = isWithinProfilePhotoSize(file.size);

    if (!typeAllowed) {
      const isIphoneFormat =
        file.type === "image/heic" || file.type === "image/heif";
      const reason = isIphoneFormat
        ? "REJECT — iPhone HEIC/HEIF format not in jpeg/png/webp allow-list"
        : `REJECT — type "${file.type || "(empty)"}" not in jpeg/png/webp allow-list`;

      setDiag("VALIDATION", "err", reason);
      setDiag("ERROR", "err", `Content type rejected: ${reason}`);
      setDiag("SERVER", "idle", "not attempted — stopped at VALIDATION");

      setUploadError(
        isIphoneFormat
          ? "This photo is in your phone's default HEIC format. In iOS Settings > Camera > Formats, choose \"Most Compatible\" and retake it, or share it to Files and upload the JPG copy."
          : "Choose a JPG, PNG or WebP image.",
      );
      return;
    }

    if (!sizeAllowed) {
      const reason = `REJECT — ${file.size} bytes outside 1..${PROFILE_PHOTO_MAX_BYTES} bytes`;

      setDiag("VALIDATION", "err", reason);
      setDiag("ERROR", "err", `Size rejected: ${file.size} bytes`);
      setDiag("SERVER", "idle", "not attempted — stopped at VALIDATION");

      setUploadError(
        `Image must be 4 MB or smaller (max ${PROFILE_PHOTO_MAX_BYTES / (1024 * 1024)} MB).`,
      );
      return;
    }

    setDiag(
      "VALIDATION",
      "ok",
      `PASS — type ${file.type}, size ${file.size} bytes within limit`,
    );

    setPending(true);
    setDiag(
      "PENDING",
      "ok",
      "setPending(true) — button should read \"Uploading…\" and input becomes disabled",
    );

    setDiag(
      "UPLOAD",
      "ok",
      `client upload() → POST ${handleUploadUrl} (prefix ${uploadPrefix})`,
    );

    try {
      const blob = await upload(
        `${uploadPrefix}${crypto.randomUUID()}-${file.name}`,
        file,
        {
          access: "public",
          handleUploadUrl,
          contentType: file.type,
        },
      );

      const probe = await probeServer(handleUploadUrl);
      setDiag(
        "SERVER",
        probe.ok ? "ok" : "err",
        `probe → ${probe.detail} · upload: token minted`,
      );

      setDiag("SUCCESS", "ok", `Blob URL: ${blob.url}`);
      setUrl(blob.url);
    } catch (uploadFailure) {
      const message =
        uploadFailure instanceof Error
          ? uploadFailure.message
          : String(uploadFailure);

      const probe = await probeServer(handleUploadUrl);
      setDiag(
        "SERVER",
        probe.ok ? "ok" : "err",
        `probe → ${probe.detail} · upload: FAILED`,
      );
      setDiag("ERROR", "err", message);

      // The failure is almost always the token route (auth, storage config,
      // rejected content type). Log it: on mobile there is no other way to
      // see what went wrong.
      console.error(`${label} upload failed`, uploadFailure);

      setUploadError(
        "Upload failed. Please check your connection and try again.",
      );
    } finally {
      setPending(false);
    }
  }

  /*
   * On iOS Safari React's synthetic onChange never fires for <input type="file">
   * because the native `change` event dispatched by the OS picker does not
   * bubble to the React root container (React 17+ delegates events on the root,
   * not on `document`).  This was previously tracked upstream as
   * https://github.com/facebook/react/issues/25308 ("event not bubbling to
   * root on iOS Safari").
   *
   * A NATIVE change listener is attached directly on the <input> element so it
   * runs regardless of React's event delegation.  A ref always points at the
   * latest handleFile closure so the listener can be registered once at mount
   * and cleaned up at unmount.  (Behaviour is under investigation — the panel
   * above reports which checkpoint the real device actually reaches.)
   */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleFileRef = useRef(handleFile);
  // Update the ref on every render so the listener always calls the latest
  // closure (which has access to the latest setUrl / setPending etc.).
  handleFileRef.current = handleFile;

  useEffect(() => {
    DIAG_MOUNTS += 1;

    const input = fileInputRef.current;

    if (!input) {
      setDiag("MOUNT", "err", "ref was NULL — effect bailed, NO listener attached");
      return;
    }

    setDiag("MOUNT", "ok", `input mounted — element ${diagTag(input)} (#${DIAG_MOUNTS})`);

    const onNativeClick = (event: Event) => {
      setDiag(
        "CLICK",
        "ok",
        `input click on element ${diagTag(event.target as HTMLInputElement)}`,
      );
    };

    const onNativeChange = (event: Event) => {
      const target = event.target as HTMLInputElement;
      const files = target.files;
      setDiag(
        "CHANGE",
        "ok",
        `native change fired on element ${diagTag(target)} — files.length=${
          files?.length ?? "n/a"
        }, type=${files?.[0]?.type ?? "(none)"}, size=${files?.[0]?.size ?? "n/a"}`,
      );
      handleFileRef.current(
        event as unknown as React.ChangeEvent<HTMLInputElement>,
      );
    };

    input.addEventListener("click", onNativeClick);
    input.addEventListener("change", onNativeChange);

    setDiag(
      "LISTENER",
      "ok",
      `native click+change listeners attached to element ${diagTag(input)}`,
    );

    return () => {
      setDiag(
        "LISTENER",
        "err",
        `effect cleanup — listeners REMOVED from element ${diagTag(input)} (component unmounting)`,
      );
      input.removeEventListener("click", onNativeClick);
      input.removeEventListener("change", onNativeChange);
    };
  }, []);

  return (
    <div className="space-y-3">
      <span className="block text-sm font-medium text-ink">{label}</span>

      {/* The URL the surrounding form persists through its existing save path. */}
      <input type="hidden" name={fieldName} value={url} />

      {/*
        The label opens the OS picker without any JavaScript, but everything
        AFTER selecting a photo (validation, Blob upload, hidden-field update)
        needs the app's JavaScript. On browsers below the supported baseline
        React never hydrates, so say so instead of failing silently.
      */}
      <noscript>
        <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
          Enable JavaScript to upload images — the picker can open without it,
          but the upload itself cannot run.
        </p>
      </noscript>

      <div className="flex flex-wrap items-center gap-4">
        <Avatar name={entityName} imageUrl={url || null} size={72} />

        <div className="flex flex-wrap items-center gap-2">
          {/*
            Native label activation, not a programmatic input.click(): a visible
            <label> wrapping a rendered (sr-only, NOT display:none) file input
            is a real user gesture on the input itself, so the OS file picker
            opens identically on iOS Safari, Android Chrome and desktop —
            WebKit silently drops synthetic clicks on non-rendered file inputs,
            which made this control dead on phones. The input stays focusable,
            so keyboard users can still tab to it and press Enter.
          */}
          <label
            className={cn(
              buttonClasses({ variant: "outline", size: "sm" }),
              pending && "pointer-events-none opacity-55",
            )}
          >
            {pending ? "Uploading…" : url ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
            <input
              type="file"
              accept={[
                "image/jpeg",
                "image/png",
                "image/webp",
                "image/heic",
                "image/heif",
              ].join(",")}
              className="sr-only"
              disabled={pending}
              ref={fileInputRef}
            />
          </label>

          {url ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => {
                setUrl("");
                setUploadError(null);
              }}
            >
              Remove
            </Button>
          ) : null}
        </div>
      </div>

      {/* TEMPORARY: visible event-chain diagnostics for the iPhone test. */}
      <DiagPanel />

      <p className="text-xs text-ink-soft">
        {acceptHint} Saving your profile keeps the new image; removing it saves
        without one.
      </p>

      {uploadError ? (
        <p role="alert" className="text-xs text-warning">
          {uploadError}
        </p>
      ) : null}

      {error ? <p className="text-xs text-warning">{error}</p> : null}
    </div>
  );
}
