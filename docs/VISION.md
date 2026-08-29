# The Pictaria way

*Why Pictaria exists, and how it thinks about your photo collection.*

## The problem with big photo libraries

If you've been taking photos for a decade or three, you have tens of
thousands of them — maybe hundreds of thousands. Somewhere in there are the
photos of your life: the trips, the birthdays, the faces of people you love
at every age they've ever been.

And around them: nine screenshots of a Wi-Fi password, forty near-identical
frames of the same sunset, receipts, parking spots, whiteboards, and that
document you photographed in 2014 for reasons lost to history.

The conventional advice is some form of *go through your library and clean
it up* — delete the junk, organize the rest, folder by folder, one photo at
a time. Almost nobody does this, because it's a part-time job with no
finish line, and because deleting photos feels dangerous. What if that
blurry frame is the only one where your grandmother is laughing?

So the library sits there, growing. The best photos of your life,
statistically invisible.

## Pictaria's stance

**Your collection is fine as it is. Don't delete anything. Don't reorganize
anything. Don't spend your weekends grinding through photos one by one.**

Pictaria is a smart overlay on the collection you already have. Your original
photo files stay exactly where they are in your own self-hosted library, and
Pictaria never alters their bytes. Pictaria adds a layer of understanding on
top — and uses it to get the best of your collection out of the archive and
onto your walls.

Pictaria's own layer is additive: notes and decisions remain in its local
state. Features you enable can also write tags, descriptions, location
metadata, and managed album membership to Immich. Turn Pictaria off tomorrow
and your original photo files remain unchanged — almost certainly with a
better-documented library around them.

## The loop

Pictaria sees working with a collection as four movements, each with its own
tool, each feeding the next:

### 1. Understand — *Insights*

Before you can do anything with 100,000 photos, you need to see the shape
of them. Insights computes the story of your collection on your own
hardware: the rhythm of photos across the years, where you were and when,
who appears together, the trips you took, the records you didn't know you
held (your busiest day, your longest quiet spell, the furthest you've been
from home). Every number is a door — click it and you're looking at those
actual photos.

### 2. Find the best — *Enrich and Curate*

This is where the overlay gets smart. **Enrich** has an AI model look at
your photos — an operator-hosted model if you want to avoid a third-party
cloud — and write down what it sees: tags from a controlled vocabulary,
a one-sentence description, and an honest opinion about whether a photo
belongs on a wall.

**Curate** is where you stay in charge. The AI's work sorts photos into
piles — likely keepers, likely junk, worth a look — so your judgment goes
exactly where it's needed. Your decisions are quick, keyboard-fast, and
final in the way that matters: recorded as tags, never as deletions.
Marking a photo "never show" doesn't remove it from your library; it just
keeps it off the frame. The screenshot stays. It simply stops photobombing
your memories.

You never have to do this exhaustively. Curate a trip. Curate a person.
Curate ten minutes' worth. Progress accumulates and nothing expires.

### 3. Select — *Albums*

Albums turn understanding into collections: living selections that build
themselves from rules — people, places, dates, cameras, curation status,
ideas — and keep themselves current as new photos arrive and new decisions
land. "Every keeper of the kids at the beach" is a rule, not a chore you
redo every summer.

### 4. Enjoy — *Pictaria Frame*

The point of all of it. Your best photos, on a frame on your wall or a
tablet on your shelf, resurfacing moments you'd forgotten you had. Ask it
questions out loud. Steer it from your phone. Let it quietly track what
it has shown you, so the deep cuts get their turn too.

## Principles

- **Original photo files are never edited or deleted.** Pictaria can update
  Immich metadata and managed album membership when you enable those features;
  its own notes and decisions remain in its local state.
- **The AI proposes; you decide.** Models sort and suggest. Human decisions
  are the record of truth, and nothing bulk ever overrides them.
- **Local first, private by default.** Pictaria Server runs on infrastructure
  you operate against your self-hosted library. AI enrichment is off until you
  explicitly turn it on. Operator-hosted models keep model requests within
  infrastructure you operate; configured cloud models receive them through
  your provider account.
- **Any slice, any pace.** Nothing demands completeness. Work on one trip,
  one person, one rainy afternoon at a time. The overlay gets smarter with
  every pass and never punishes you for stopping.
- **Honest numbers.** Counts, coverage, and progress reflect what's actually
  there — including what hasn't been looked at yet.

## In one sentence

Pictaria is the smart layer between the photos you've taken and the walls
you live with — it understands your collection, helps you find the best of
it, and puts those photos back into your life, without asking you to change
a thing about how you keep them.
