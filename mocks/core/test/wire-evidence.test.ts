import { describe, expect, it } from "vitest";
import { generateManifest, PROFILES } from "../src/manifest.js";
import { normalizeDomain } from "../src/normalize.js";

// F-1c: the support identity arm re-sources from the casebus wire, and a faithful Case
// wire carries ONLY the supplied-* intake fields (SuppliedEmail / SuppliedName /
// SuppliedCompany + nullable ContactId — f2-wire-research.md Q2; the Case object has no
// "domain" field to enrich with). Staging therefore derives the entity's DOMAIN evidence
// from SuppliedEmail. That is only sound if the universe puts the domain evidence INSIDE
// the email for every requester whose tier depends on domain matching:
//   · tier-1 requesters (S-0001..S-0009) resolve on EXACT contact-email equality — their
//     domain is never consulted;
//   · tier-2 (S-0010/S-0011), the near-miss (S-0012), and the standalones (S-0013/14)
//     carry domain evidence, so their email's own domain must BE that evidence —
//     normalizeDomain(requester.domain), the same normalization the SQL side applies.
// This pin is what makes "the supplied-* fields are the tier evidence" true rather than
// aspirational, for every profile.
describe("F-1c: support tier evidence is derivable from the wire's supplied fields alone", () => {
  for (const profile of PROFILES) {
    it(`[${profile}] every domain-evidence requester's email domain IS its normalized domain evidence`, () => {
      const m = generateManifest(42, profile);
      const domainEvidenceRequesters = m.support.requesters.slice(9); // S-0010..S-0014
      expect(domainEvidenceRequesters).toHaveLength(5);
      for (const r of domainEvidenceRequesters) {
        const emailDomain = r.email.split("@")[1];
        expect(emailDomain, `${r.id} email ${r.email} must carry its domain evidence`).toBe(
          normalizeDomain(r.domain),
        );
      }
    });
  }
});
