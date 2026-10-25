# Third Party Notices

## Bible Strong Avatar Lab (mascot)

Replay's mascot, Reel, is rendered with `@bible-strong/avatar-core` 0.1.0,
distributed under the GNU Affero General Public License v3.0 only
(AGPL-3.0-only). The avatar definition
(`apps/web/components/mascot/avatar.avatar.json`) was written for Replay and
is validated with the package's own validator; the SVG surface that applies
the rendered frames (`components/mascot/AvatarSurface.tsx`) is Replay's own
code and adds only the documented scene scale. The official
`@bible-strong/avatar-react` wrapper was evaluated and removed after its
0.1.0 release was found to render the core's unit-scale geometry without the
scale transform (avatar paints sub-pixel, invisible). The Studio editor
(https://avatars.bible-strong.app,
https://github.com/smontlouis/bible-strong-avatar-lab) was not used and no
Studio source is vendored here.

License review, recorded before deployment: Replay is MIT-licensed and its
source is public. The AGPL package is used unmodified, as an npm dependency,
and its source is publicly available. Network use of a site that ships an
AGPL library is generally understood to require that the Corresponding Source
for the AGPL-covered work be offered to its users; because the package is
unmodified and its source is already public, attribution here plus the public
repository is the compliance position taken. If stricter interpretation is
required for the hackathon build, removing the mascot components removes the
only AGPL dependency from the frontend.

## Other dependencies

Next.js, React, Tailwind CSS, Radix UI tabs, Lucide icons, Monaco editor,
react-markdown, Zod, Geist fonts and Supabase JS are used under their own
MIT or Apache-2.0 licenses via npm.
