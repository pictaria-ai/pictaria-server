# Contributing to Pictaria Server

Thanks for wanting to improve Pictaria. A few ground rules keep
contributions easy to accept:

- **One focused change per pull request.** Small, reviewable PRs merge
  fastest.
- **Run the suite** (`npm test`) before opening a PR. It is fast, has zero
  npm dependencies, and must stay green.
- **User-facing changes** update the `CHANGELOG.md` Unreleased section in
  the same PR.
- Match the design rules in the README (zero dependencies, Node built-ins
  only, human decisions win over AI output).

## License and sign-off

Pictaria Server is licensed under the GNU Affero General Public License,
version 3 only (`AGPL-3.0-only`). By contributing, you agree that your
contribution is licensed under the same terms ("inbound = outbound"). You
keep the copyright to your contribution; no copyright assignment and no
contributor license agreement is required.

What we do require is the **Developer Certificate of Origin** sign-off: a
`Signed-off-by` line in each commit certifying you have the right to submit
the code under this license. CI enforces this on every proposed commit. Git
adds it for you:

```
git commit -s
```

The certificate you are agreeing to:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
