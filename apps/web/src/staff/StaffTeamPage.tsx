import { formatToken, type ListStaffInvitationsResult, type StaffInvitationSummary } from "@itssb/contracts";
import { useState } from "react";
import { dateTime, invitationState } from "./format";
import type { StaffSource } from "./source";
import { Empty, Loaded, Outcome, type Ready, useMutation, useStaffQuery } from "./ui";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Staff invitations (docs/12 §1). A code admits one new person as staff
 * after they sign in; the server checks it, and only its hash is stored.
 */
export function StaffTeamPage({ source }: { source: StaffSource }) {
  const { state } = useStaffQuery<Ready<ListStaffInvitationsResult>>(source, "staffInvitations:list");
  const { busy, outcome, last, act } = useMutation(source);
  const [name, setName] = useState("");
  const [days, setDays] = useState("3");
  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="invite-staff">
        <h1 id="invite-staff">Invite a staff member</h1>
        <p className="muted small">
          Staff see every bus and every family&apos;s requests. The code works once, for the first person who signs in and
          enters it. Give it to them in person or by phone.
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void act("staffInvitations:create", { displayName: name, ttlMs: Number(days) * DAY }, "Invitation created.");
          }}
        >
          <label style={{ flex: "1 1 12rem" }}>
            Their name
            <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Jamie Staff" />
          </label>
          <label style={{ flex: "0 1 8rem" }}>
            Valid for
            <select value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="1">1 day</option>
              <option value="3">3 days</option>
              <option value="7">7 days</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()} style={{ alignSelf: "flex-end" }}>
            Create code
          </button>
        </form>
        <CreatedStaffCode raw={last} />
        <Outcome outcome={outcome} />
      </section>
      <section className="card stack">
        <h2>Staff invitations</h2>
        <Loaded state={state}>
          {({ invitations, serverNowMs }) =>
            invitations.length === 0 ? (
              <Empty text="No staff invitations yet." />
            ) : (
              <table className="responsive-table">
                <thead>
                  <tr>
                    <th>For</th>
                    <th>State</th>
                    <th>Issued</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((i) => (
                    <StaffInvitationRow key={i.invitationId} source={source} invitation={i} serverNowMs={serverNowMs} />
                  ))}
                </tbody>
              </table>
            )
          }
        </Loaded>
      </section>
    </div>
  );
}

function CreatedStaffCode({ raw }: { raw: unknown }) {
  const created = raw as { status?: unknown; token?: unknown; expiresAtMs?: unknown } | null;
  if (created?.status !== "created" || typeof created.token !== "string" || typeof created.expiresAtMs !== "number") return null;
  return (
    <div className="card stack secret-panel" style={{ gap: "var(--space-xs)" }} role="status">
      <p className="muted small">Copy this now. It won&apos;t be shown again.</p>
      <p className="code-display">{formatToken(created.token)}</p>
      <p className="muted small">
        They sign in on this website with their own email, choose &quot;Join as staff&quot;, and enter the code. Expires{" "}
        {dateTime(created.expiresAtMs)}.
      </p>
    </div>
  );
}

function StaffInvitationRow({
  source,
  invitation: i,
  serverNowMs,
}: {
  source: StaffSource;
  invitation: StaffInvitationSummary;
  serverNowMs: number;
}) {
  const { busy, outcome, run } = useMutation(source);
  const view = invitationState(i, serverNowMs);
  return (
    <tr>
      <td data-label="For">{i.displayName}</td>
      <td data-label="State">{view.text}</td>
      <td data-label="Issued">
        {dateTime(i.issuedAtMs)}
        {i.issuedByName && <div className="muted small">by {i.issuedByName}</div>}
      </td>
      <td>
        {view.pending && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void run("staffInvitations:revoke", { invitationId: i.invitationId }, "Revoked.")}
          >
            Revoke
          </button>
        )}
        <Outcome outcome={outcome} />
      </td>
    </tr>
  );
}
