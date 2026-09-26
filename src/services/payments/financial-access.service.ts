import "server-only";

import { prisma } from "@/lib/prisma";
import { getSupportActor } from "@/lib/authz";
import type { FinancialObligation } from "@/generated/prisma/client";

/**
 * Stage 13A — financial access control.
 *
 * Financial records are readable ONLY by parties to the underlying agreement:
 *
 *   - Advertiser: obligations on their own agreements (their own payment info);
 *   - Creator: obligations where they are the agreed creator;
 *   - Support (Stage 14D): the trusted internal operator. READ-ONLY and
 *     authorization-carrying: the viewer variant exists precisely so that
 *     Support can inspect any obligation/ledger/events for operational
 *     review, and it is only obtainable through a currently rostered
 *     SUPPORT session (resolveSupportFinancialViewer). This is inspection,
 *     never ownership — Support still cannot write money state through this
 *     module, and creators/advertisers gain nothing new.
 *
 * The ownership predicate lives INSIDE every query — foreign or guessed ids
 * return null/empty lists rather than errors, mirroring agreement.service.
 */

export type FinancialViewer =
  | { role: "ADVERTISER"; advertiserProfileId: string }
  | { role: "CREATOR"; creatorProfileId: string }
  // Stage 14D — trusted internal operator. Unscoped: authorization comes
  // from the SUPPORT role + support roster, checked at resolution time.
  | { role: "SUPPORT" };

function viewerFilter(viewer: FinancialViewer) {
  switch (viewer.role) {
    case "ADVERTISER":
      return { advertiserId: viewer.advertiserProfileId };
    case "CREATOR":
      return { creatorId: viewer.creatorProfileId };
    case "SUPPORT":
      // No ownership scoping: the SUPPORT role + roster IS the authorization
      // (resolved in resolveSupportFinancialViewer). Never construct this
      // viewer from client input.
      return {};
  }
}

/**
 * Resolve the ONLY sanctioned path to the SUPPORT financial viewer: a live
 * server session with the SUPPORT role whose user is on the operator-
 * maintained support roster (fresh-DB check — fail-closed when the roster
 * is empty or membership was revoked). Every other role resolves to null.
 */
export async function resolveSupportFinancialViewer(): Promise<
  { role: "SUPPORT" } | null
> {
  const actor = await getSupportActor();

  return actor ? { role: "SUPPORT" } : null;
}

/**
 * One obligation by id for an authorized party. Unrelated viewers (including
 * anonymous ones) get null — never an error that leaks existence. SUPPORT
 * viewers are authorization-carrying (see above), not party-scoped.
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
 * The ledger trail of one obligation — party-scoped (read-any for SUPPORT).
 * Amounts are BigInt minor units; serialization to strings happens in the
 * presentation layer.
 */
export async function listLedgerEntriesForViewer(
  obligationId: string,
  viewer: FinancialViewer,
) {
  // Authorization first: the viewer must be a party to this obligation (or
  // a rostered SUPPORT operator).
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
 * Financial events for one obligation — party-scoped (read-any for SUPPORT).
 * Metadata is stored secret-free, but it is still only exposed to parties of
 * the obligation or to a rostered SUPPORT operator.
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
