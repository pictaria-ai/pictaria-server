# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to
[security@pictaria.ai](mailto:security@pictaria.ai). When GitHub private
vulnerability reporting is available for this repository, the private
reporting form under the Security tab is also a preferred channel.

We aim to acknowledge reports within three business days. Please allow us a
reasonable opportunity to investigate, coordinate a fix, and agree on a
disclosure timeline before publishing details.

## Supported versions

Security updates are provided for the latest published release only.

## System and scope

Pictaria Server is a single-installation, self-hosted companion for one Immich
photo library. It runs as one Node.js service and is designed for a trusted
LAN or private VPN such as Tailscale or WireGuard. Direct Internet exposure by
port forwarding is not a supported deployment.

This policy covers the server, browser UI and API, Frame connections, outbound
Immich and optional provider integrations, persistent state, backups,
container configuration, and everything tracked for public distribution.

## Threat model and trust boundaries

Untrusted inputs include:

- unauthenticated LAN or VPN clients;
- hostile browser origins attempting to use a browser as a path into the LAN;
- request headers, URLs, bodies, uploaded models, and identifiers;
- Immich, AI, TTS, weather, and geocoding responses;
- restored or separately mounted persistent and backup data; and
- every file, image, fixture, example, and commit intended for publication.

The host operator, environment variables, container deployment, filesystem
ownership, configured bind and volume paths, and explicit proxy allowlist are
trusted. An `APP_PASSWORD` holder is an installation administrator and is
expected to have broad authority over Pictaria and its connected Immich
library. A password holder is not assumed to know environment-only provider or
Immich secrets, so changing an endpoint must not silently rebind such a secret
to a different authority.

`ALLOW_INSECURE_OPEN=true` deliberately grants installation-administrator
authority to every client that can directly reach the service. It does not
make hostile browser origins, upstream responses, the host filesystem, or
third-party credential destinations trusted.

## Security invariants

- With `APP_PASSWORD` configured, protected data and mutations require a valid
  credential or session. Open mode must require its explicit dangerous opt-in.
- Browser Host, Origin, cookie, and content-type controls must prevent an
  unrelated website from acquiring the authority of a LAN client.
- Application, session, Immich, and provider secrets must not be returned,
  logged, persisted with unsafe permissions, or forwarded to a different
  authority through configuration changes or redirects.
- Untrusted bodies, media, uploaded models, identifiers, pagination, and batch
  requests must be validated and bounded before expensive parsing, buffering,
  storage, provider work, or persistent growth.
- Persistent state and backups must remain within their configured trusted
  locations, resist substitution by entries inside those boundaries, preserve
  recoverability, and use restrictive permissions where the platform supports
  them. Operator-configured path components, bind mounts, and volume roots are
  trusted deployment choices and may be resolved and pinned rather than
  rejected merely because they use a link.
- A malformed request or upstream response must fail closed without crashing
  the process, exposing private details, or creating unbounded log or resource
  amplification.
- The public repository must contain no credentials, private operational
  material, unintended personal or network identifiers, or unwanted reachable
  development history.

## Reportable findings and severity context

A finding is reportable when it crosses one of the boundaries above under a
supported deployment. Examples include authentication bypass, hostile-browser
access, cross-authority credential forwarding, private-photo or secret
disclosure, unintended Immich mutation, arbitrary file access or overwrite,
unsafe parsing of untrusted content, persistent unbounded growth, or a
practical availability or provider-cost attack.

Severity should reflect the intended LAN/private-VPN deployment, the single
administrator-equivalent credential, required privileges, default
configuration, exploit reliability, persistence, and impact. A direct path
from an unauthenticated client or hostile browser origin is more serious than
the same operation performed by an authenticated installation administrator.
Administrator-triggered resource use remains reportable when it crosses into
protected host state, undisclosed environment secrets, another authority, or
disproportionate persistent or billed impact.

## Out of scope and accepted risk

- Direct exposure of Pictaria's plain-HTTP port to the public Internet is
  unsupported. Reports that require ignoring the documented HTTPS proxy or
  private-VPN guidance should be assessed as hardening unless another
  supported boundary is crossed.
- Plain HTTP is accepted on a network the operator trusts against passive and
  active interception. HTTPS remains required when that assumption does not
  hold.
- `APP_PASSWORD` holders intentionally share broad installation-admin access;
  the absence of per-user roles or tenant isolation is not an authorization
  vulnerability.
- Open mode intentionally removes application authentication for direct
  network clients. Effects no greater than that documented authority are not
  authentication bypasses.
- Code execution, file modification, or state disclosure by a process already
  controlling the host, container runtime, or Pictaria data directory is
  outside the application boundary unless a less-privileged supported input
  reaches that outcome.
- The four README product screenshots are owner-reviewed publication assets.
  Their visible names are fictitious, photo faces are intentionally blurred,
  and visible city-level place names are owner-approved. Their approved visible
  demo content is not a finding; credentials, exact private network identifiers,
  sensitive embedded metadata, or unapproved personal content would remain
  reportable.

## Known limitations and compensating controls

Pictaria uses one shared password rather than user accounts or roles. Browser
sessions last up to 30 days and are invalidated when the password changes.
Open mode displays a persistent warning and should be used only on an isolated
network. For access beyond a trusted LAN, use a private VPN or an HTTPS reverse
proxy, enable secure cookies, preserve the public Host header, configure only
the exact trusted proxy addresses, and never expose the container port
directly to the Internet.
