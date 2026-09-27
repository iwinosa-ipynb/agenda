"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";

import {
  contactManagedBriefCandidateAction,
  declineManagedBriefCandidateAction,
  recordOutreachDeclinedAction,
  recordOutreachInterestedAction,
  removeManagedBriefCandidateAction,
  setManagedBriefCandidateNoteAction,
  setOutreachNoteAction,
  transitionManagedBriefCandidateAction,
} from "@/app/dashboard/_actions/managed-brief-candidates";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/field";
import {
  MANAGED_BRIEF_CANDIDATE_STATUS_LABELS,
  MANAGED_BRIEF_OUTREACH_STATUS_LABELS,
  PLATFORM_LABELS,
} from "@/lib/constants";
import type {
  ActionResult,
  ManagedBriefCandidateStatus,
  ManagedBriefOutreachStatus,
  Platform,
  SocialAccountStatus,
} from "@/types";

/** The outreach sub-record passed to the row (slice 4 read model). */
export type OutreachView = {
  status: ManagedBriefOutreachStatus;
  contactedAt: Date;
  respondedAt: Date | null;
  note: string | null;
  contactedById: string;
  respondedById: string | null;
};

/**
 * One candidate row in the Support sourcing workspace (slice 3 + slice 4
 * outreach panel).
 *
 * Client-side controls render only; every mutation is a server action that
 * re-runs the Stage 14D seam and the service-side state machines. The next
 * candidate/outreach status is NEVER chosen here: the client presses a fixed
 * button (advance, decline, mark contacted, record response), and the server
 * derives and validates the target against the STORED status.
 */
export function ManagedBriefCandidateRow({
  candidateId,
  status,
  note,
  statusUpdatedAt,
  statusUpdatedById,
  creatorName,
  creatorUsername,
  creatorCategory,
  creatorFollowerCount,
  accountPlatform,
  accountUsername,
  accountProfileUrl,
  accountStatus,
  accountFollowerCount,
  outreach,
}: {
  candidateId: string;
  status: ManagedBriefCandidateStatus;
  note: string | null;
  statusUpdatedAt: Date | null;
  statusUpdatedById: string | null;
  creatorName: string;
  creatorUsername: string;
  creatorCategory: string | null;
  creatorFollowerCount: number;
  accountPlatform: Platform;
  accountUsername: string;
  accountProfileUrl: string;
  accountStatus: SocialAccountStatus;
  accountFollowerCount: number | null;
  outreach: OutreachView | null;
}) {
  const [transitionState, transitionAction, isTransitioning] = useActionState<
    ActionResult | null,
    FormData
  >(transitionManagedBriefCandidateAction, null);
  const [noteState, noteAction, isSavingNote] = useActionState<
    ActionResult | null,
    FormData
  >(setManagedBriefCandidateNoteAction, null);
  const [removeState, removeAction, isRemoving] = useActionState<
    ActionResult | null,
    FormData
  >(removeManagedBriefCandidateAction, null);
  const [declineState, declineAction, isDeclining] = useActionState<
    ActionResult | null,
    FormData
  >(declineManagedBriefCandidateAction, null);
  const [contactState, contactAction, isContacting] = useActionState<
    ActionResult | null,
    FormData
  >(contactManagedBriefCandidateAction, null);
  const [interestedState, interestedAction, isRecordingInterested] =
    useActionState<ActionResult | null, FormData>(
      recordOutreachInterestedAction,
      null,
    );
  const [declinedState, declinedAction, isRecordingDeclined] = useActionState<
    ActionResult | null,
    FormData
  >(recordOutreachDeclinedAction, null);
  const [outreachNoteState, outreachNoteAction, isSavingOutreachNote] =
    useActionState<ActionResult | null, FormData>(setOutreachNoteAction, null);

  const router = useRouter();

  // Note editor open/close is driven ONLY by click handlers (no setState in
  // effects); textareas are uncontrolled and keyed by the saved note, so they
  // re-sync with server state after a successful save + refresh.
  const [editingNote, setEditingNote] = useState(false);
  const [editingOutreachNote, setEditingOutreachNote] = useState(false);
  const noteFieldId = useId();
  const outreachNoteFieldId = useId();

  useEffect(() => {
    if (
      transitionState?.success ||
      removeState?.success ||
      declineState?.success ||
      noteState?.success ||
      contactState?.success ||
      interestedState?.success ||
      declinedState?.success ||
      outreachNoteState?.success
    ) {
      router.refresh();
    }
  }, [
    transitionState,
    removeState,
    declineState,
    noteState,
    contactState,
    interestedState,
    declinedState,
    outreachNoteState,
    router,
  ]);

  const error =
    (transitionState && !transitionState.success && transitionState.error) ||
    (noteState && !noteState.success && noteState.error) ||
    (removeState && !removeState.success && removeState.error) ||
    (declineState && !declineState.success && declineState.error) ||
    (contactState && !contactState.success && contactState.error) ||
    (interestedState && !interestedState.success && interestedState.error) ||
    (declinedState && !declinedState.success && declinedState.error) ||
    (outreachNoteState && !outreachNoteState.success && outreachNoteState.error) ||
    null;

  // The server decides the next status; the UI just labels the one available
  // transition (or shows terminal-state text). Mirrors the map in
  // MANAGED_BRIEF_CANDIDATE_TRANSITIONS — display only, never authoritative.
  // These are the SLICE 3 internal pipeline labels; the slice 4 outreach
  // panel below tracks the off-platform contact/response separately.
  const nextStatusLabel =
    status === "PROSPECT"
      ? "Mark contacted"
      : status === "CONTACTED"
        ? "Mark interested"
        : status === "INTERESTED"
          ? "Mark selected"
          : null;

  const showNoteForm = editingNote;
  // DECLINED/SELECTED are terminal — no decline button in a terminal state.
  const canDecline = status === "PROSPECT" || status === "CONTACTED" || status === "INTERESTED";

  // Slice 4: outreach panel. The record exists once the candidate has been
  // marked contacted; the response buttons render only while the record is
  // in CONTACTED (both INTERESTED/DECLINED are terminal).
  const outreachStatus = outreach?.status ?? null;
  const awaitingResponse = outreachStatus === "CONTACTED";

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">
              {creatorName}
            </span>
            <span className="text-sm text-ink-soft">@{creatorUsername}</span>
            {creatorCategory ? (
              <span className="text-xs text-ink-faint">
                {creatorCategory}
              </span>
            ) : null}
          </div>
          <a
            href={accountProfileUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="block truncate text-sm text-accent underline-offset-4 hover:underline"
          >
            {PLATFORM_LABELS[accountPlatform]}: @{accountUsername}
          </a>
          <p className="text-xs text-ink-faint">
            Creator-reported {creatorFollowerCount.toLocaleString("en-GB")}{" "}
            followers · Account{" "}
            {accountFollowerCount === null
              ? "followers pending verification"
              : `${accountFollowerCount.toLocaleString("en-GB")} followers`},{" "}
            account status {accountStatus.replaceAll("_", " ").toLowerCase()}
          </p>
          <p className="text-xs text-ink-faint">
            {statusUpdatedAt
              ? `Status updated ${statusUpdatedAt.toLocaleDateString("en-GB")}${statusUpdatedById ? ` · by ${statusUpdatedById}` : ""}`
              : "Status never advanced"}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge status={status} />
          {nextStatusLabel ? (
            <form action={transitionAction}>
              <input type="hidden" name="candidateId" value={candidateId} />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={isTransitioning}
              >
                {isTransitioning ? "Updating…" : nextStatusLabel}
              </Button>
            </form>
          ) : null}
          {canDecline ? (
            <form action={declineAction}>
              <input type="hidden" name="candidateId" value={candidateId} />
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                disabled={isDeclining}
              >
                {isDeclining ? "Declining…" : "Decline"}
              </Button>
            </form>
          ) : null}
          <form action={removeAction}>
            <input type="hidden" name="candidateId" value={candidateId} />
            <Button type="submit" variant="ghost" size="sm" disabled={isRemoving}>
              {isRemoving ? "Removing…" : "Remove"}
            </Button>
          </form>
        </div>
      </div>

      {/* ---------------------------------------------------------------
          Outreach panel (slice 4) — internal tracking of off-platform
          contact. NOTHING is sent to the creator by these controls; they
          record what support did off-platform. Support-eyes only.
         --------------------------------------------------------------- */}
      <div className="mt-3 rounded-lg border border-line bg-surface-muted/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-soft">
              Outreach
            </span>
            {outreach ? (
              <OutreachStatusBadge status={outreachStatus!} />
            ) : (
              <span className="text-xs text-ink-faint">Not contacted yet</span>
            )}
          </div>

          {!outreach ? (
            <form action={contactAction}>
              <input type="hidden" name="candidateId" value={candidateId} />
            <Button type="submit" variant="accent" size="sm" disabled={isContacting}>
              {isContacting ? "Recording…" : "Log outreach"}
            </Button>
            </form>
          ) : null}
        </div>

        {outreach ? (
          <p className="mt-2 text-xs text-ink-faint">
            Contacted {outreach.contactedAt.toLocaleDateString("en-GB")} · by{" "}
            {outreach.contactedById}
            {outreach.respondedAt
              ? ` · Responded ${outreach.respondedAt.toLocaleDateString("en-GB")}${outreach.respondedById ? ` · by ${outreach.respondedById}` : ""}`
              : ""}
          </p>
        ) : null}

        {awaitingResponse ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-soft">
              Record the creator&apos;s response:
            </span>
            <form action={interestedAction}>
              <input type="hidden" name="candidateId" value={candidateId} />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={isRecordingInterested}
              >
                {isRecordingInterested ? "Recording…" : "Interested"}
              </Button>
            </form>
            <form action={declinedAction}>
              <input type="hidden" name="candidateId" value={candidateId} />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={isRecordingDeclined}
              >
                {isRecordingDeclined ? "Recording…" : "Declined"}
              </Button>
            </form>
          </div>
        ) : null}

        {outreach ? (
          <div className="mt-3 space-y-2 border-t border-line pt-2">
            {editingOutreachNote ? (
              <form action={outreachNoteAction} className="space-y-2">
                <input type="hidden" name="candidateId" value={candidateId} />
                <Label htmlFor={outreachNoteFieldId} className="sr-only">
                  Outreach note
                </Label>
                <Textarea
                  id={outreachNoteFieldId}
                  name="outreachNote"
                  rows={2}
                  maxLength={1000}
                  disabled={isSavingOutreachNote}
                  key={outreach.note ?? "empty"}
                  defaultValue={outreach.note ?? ""}
                  placeholder="Internal note about the outreach/response…"
                />
                <div className="flex items-center gap-2">
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={isSavingOutreachNote}
                  >
                    {isSavingOutreachNote ? "Saving…" : "Save outreach note"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isSavingOutreachNote}
                    onClick={() => setEditingOutreachNote(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <p className="whitespace-pre-line text-sm text-ink-soft">
                  {outreach.note ? (
                    outreach.note
                  ) : (
                    <span className="text-ink-faint">No outreach note yet.</span>
                  )}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingOutreachNote(true)}
                >
                  {outreach.note ? "Edit" : "Add note"}
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Internal candidate note — support-eyes only; this component renders
          ONLY on the support detail page, never on any advertiser- or
          creator-facing surface. */}
      <div className="mt-3 space-y-2">
        {showNoteForm ? (
          <form action={noteAction} className="space-y-2">
            <input type="hidden" name="candidateId" value={candidateId} />
            <Label htmlFor={noteFieldId} className="sr-only">
              Internal note
            </Label>
            <Textarea
              id={noteFieldId}
              name="note"
              rows={2}
              maxLength={1000}
              disabled={isSavingNote}
              key={note ?? "empty"}
              defaultValue={note ?? ""}
              placeholder="Internal note — why this creator, what was discussed…"
            />
            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={isSavingNote}>
                {isSavingNote ? "Saving…" : "Save note"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isSavingNote}
                onClick={() => setEditingNote(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex items-start justify-between gap-3">
            <p className="whitespace-pre-line text-sm text-ink-soft">
              {note ? (
                note
              ) : (
                <span className="text-ink-faint">No internal note yet.</span>
              )}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditingNote(true)}
            >
              {note ? "Edit note" : "Add note"}
            </Button>
          </div>
        )}
      </div>

      {error ? (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function StatusBadge({ status }: { status: ManagedBriefCandidateStatus }) {
  const tone =
    status === "SELECTED"
      ? "bg-accent-soft text-accent-strong"
      : status === "DECLINED"
        ? "bg-danger-soft text-danger"
        : status === "INTERESTED"
          ? "bg-warning-soft text-warning"
          : status === "CONTACTED"
            ? "bg-surface-muted text-ink-soft"
            : "border border-line bg-surface text-ink-soft";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}
    >
      {MANAGED_BRIEF_CANDIDATE_STATUS_LABELS[status]}
    </span>
  );
}

function OutreachStatusBadge({ status }: { status: ManagedBriefOutreachStatus }) {
  const tone =
    status === "INTERESTED"
      ? "bg-accent-soft text-accent-strong"
      : status === "DECLINED"
        ? "bg-danger-soft text-danger"
        : "bg-surface-muted text-ink-soft";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}
    >
      {MANAGED_BRIEF_OUTREACH_STATUS_LABELS[status]}
    </span>
  );
}
