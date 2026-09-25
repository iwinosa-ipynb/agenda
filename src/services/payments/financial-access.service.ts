import "server-only";

import { prisma } from "@/lib/prisma";
import type { FinancialObligation } from "@/generated/prisma/client";

/**
 * Stage 13A — financial access control.
 *
 * Financial records are readable ONLY by parties to the underlying agreement:
 *
 *   - Advertiser: obligations on their own agreements (their own payment info);
 *   - Creator: obligations where they are the agreed creator;
 *   - Admin/operations: reserved for a future admin authorization architecture
 *     (Agenda currently has only CREATOR/ADVERTISER roles — no admin role
 *     exists yet, so no admin read path is exposed).
 *
 * The ownership predicate lives INSIDE every query — foreign or guessed ids
 * return null/empty lists rather than errors, mirroring agreement.service.
 */

export type FinancialViewer =
  | { role: "ADVERTISER"; advertiserProfileId: string }
  | { role: "CREATOR"; creatorProfileId: string };

function viewerFilter(viewer: FinancialViewer) {
  return viewer.role === "ADVERTISER"
    ? { advertiserId: viewer.advertiserProfileId }
    : { creatorId: viewer.creatorProfileId };
}

/**
 * One obligation by id for an authorized party. Unrelated viewers (including
 * anonymous ones) get null — never an error that leaks existence.
 */
export async function getObligationForViewer(
  obligationId: string,
  viewer: FinancialViewer,
): Promise<FinancialObligation | null> {
  return prisma.financialObligation.findFirst({
    where: { id: obligationId, ...viewerFilter(viewer) },
  });
}

/** All obligations visible to this viewer, newest first. */
export async function listObligationsForViewer(
  viewer: FinancialViewer,
): Promise<FinancialObligation[]> {
  return prisma.financialObligation.findMany({
    where: viewerFilter(viewer),
    orderBy: { createdAt: "desc" },
  });
}

/**
 * The ledger trail of one obligation — party-scoped. Amounts are BigInt
 * minor units; serialization to strings happens in the presentation layer.
 */
export async function listLedgerEntriesForViewer(
  obligationId: string,
  viewer: FinancialViewer,
) {
  // Authorization first: the viewer must be a party to this obligation.
  const obligation = await getObligationForViewer(obligationId, viewer);

  if (!obligation) {
    return null;
  }

  return prisma.ledgerEntry.findMany({
    where: { financialObligationId: obligationId },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Financial events for one obligation — party-scoped. Metadata is stored
 * secret-free, but it is still only exposed to parties of the obligation.
 */
export async function listFinancialEventsForViewer(
  obligationId: string,
  viewer: FinancialViewer,
) {
  const obligation = await getObligationForViewer(obligationId, viewer);

  if (!obligation) {
    return null;
  }

  return prisma.financialEvent.findMany({
    where: { obligationId },
    orderBy: { createdAt: "asc" },
  });
}
