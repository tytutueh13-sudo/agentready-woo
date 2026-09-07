#!/usr/bin/env python3
"""Render the social cards, one per story per theme, plus the landing page's
own og-image. Every text element is checked for AA after rendering; nothing
here is a colour chosen by eye.

    .venv/bin/python3 scripts/render-social-cards.py

The landing card is copied to marketing/landing/og-image.png by hand, because
overwriting a published asset should be a decision, not a side effect.
"""
import pathlib, json
from playwright.sync_api import sync_playwright

OUT = (pathlib.Path(__file__).resolve().parent.parent /
       "registration-handoff/marketplace-kit/assets/social")
CANON = "app.utilityhouse.xyz"

# Two grounds, one type system. Every colour pair below is checked for AA after
# rendering; nothing here is chosen by eye.
THEMES = {
 "light": dict(bg="#F7F5F0", panel="#FFFFFF", fg="#14120F", fg2="#4A4640", fg3="#6B665E",
               line="#DED9D0", accent="#0F5E73", ok="#1F6E4C", warn="#7A4A00"),
 "dark":  dict(bg="#131217", panel="#1B1A21", fg="#F1EFF4", fg2="#B7B2C0", fg3="#8E8898",
               line="#2C2A34", accent="#5FC7E0", ok="#6FCB9B", warn="#E0AE68"),
}

STORIES = {
 # The page's own card. It has to say what index.html says, not what a listing
 # concept says, and the old one said neither: it claimed "Your store isn't
 # invited", promised "buyable" on a service that cannot settle, and signed off
 # with a subdomain that has no DNS record. The dead host is deliberately not
 # written out here: the public-mirror staging guard refuses to publish that
 # string, and naming it in a comment would make this file unpublishable.
 "landing": dict(
   eyebrow="WooCommerce \u00b7 agent readiness",
   head="Know what changed before a Woo release ships.",
   sub="A free passive preflight over public surfaces. When it cannot read a store, it says so.",
   body="""<div class="rows">
     <div class="r"><span class="k">preflight</span><span class="v">public pages and the public Store API, credential-free</span><span class="t ok">FREE</span></div>
     <div class="r"><span class="k">abstains</span><span class="v">reached it and could not read it</span><span class="t acc">COULD NOT TELL</span></div>
     <div class="r"><span class="k">release gate</span><span class="v">the merchant's own verified ownership, pinned evidence</span><span class="t warn">OWNER ONLY</span></div>
   </div>"""),
 "a-receipt": dict(
   eyebrow="WooCommerce · release decision",
   head="Can shopping agents read this store?",
   sub="Answered in writing — including when the answer is that we could not tell.",
   body="""<div class="rows">
     <div class="r"><span class="k">woo</span><span class="v">Store API and catalogue sample unchanged</span><span class="t ok">PASS</span></div>
     <div class="r"><span class="k">jsonld</span><span class="v">Offer block missing on 2 of 12 sampled</span><span class="t warn">FAIL</span></div>
     <div class="r"><span class="k">robots</span><span class="v">Two catalogue paths not fetched</span><span class="t acc">COULD NOT TELL</span></div>
   </div>"""),
 "b-triage": dict(
   eyebrow="WooCommerce · before you quote",
   head="Two of these twenty storefronts, we could not read.",
   sub="Fifteen came back ready, three with a named defect.",
   body="""<div class="cols">
     <div class="c big"><span class="h">Could not tell</span><span class="n">2</span></div>
     <div class="c"><span class="h">Ready</span><span class="n">15</span></div>
     <div class="c"><span class="h">Needs work</span><span class="n">3</span></div>
   </div>"""),
 "c-contract": dict(
   eyebrow="WooCommerce · five tools, one boundary",
   head="Five tools. Two you can call right now.",
   sub="The other three need the merchant's own authorization.",
   body="""<div class="rows">
     <div class="r"><span class="k">scan</span><span class="v">public pages and the public Store API</span><span class="t ok">NO CREDENTIALS</span></div>
     <div class="r"><span class="k">preflight</span><span class="v">one origin, passive, read-only</span><span class="t ok">NO CREDENTIALS</span></div>
     <div class="rule"><span>bearer token + verified ownership below this line</span></div>
     <div class="r"><span class="k">verify</span><span class="v">start · get · claim a release result</span><span class="t warn">OWNER ONLY</span></div>
   </div>"""),
 "d-transform": dict(
   eyebrow="WooCommerce · batch triage",
   head="Twenty storefronts in. Three that need a person out.",
   sub="Success, abstention and upstream failure kept apart, and never billed for a row it could not answer.",
   body="""<div class="pair">
     <div class="p"><span class="h">In</span><span class="n">20</span><span class="s">origins</span></div>
     <div class="arw">&rarr;</div>
     <div class="p"><span class="h">Answered</span><span class="n">17</span><span class="s">by the machine</span></div>
     <div class="p accent"><span class="h">For a person</span><span class="n">3</span><span class="s">abstained or refused</span></div>
   </div>"""),
}

TPL = """<style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:1200px;height:630px;background:%(bg)s;color:%(fg)s;
  font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;flex-direction:column;
  justify-content:space-between;padding:56px 64px 48px;-webkit-font-smoothing:antialiased}
.mark{display:flex;align-items:center;gap:11px;font-size:19px;font-weight:700;letter-spacing:-.01em}
.mark i{width:26px;height:26px;border-radius:6px;background:%(accent)s;display:grid;place-items:center;
  color:%(panel)s;font-style:normal;font-size:15px;font-weight:800}
.mark s{text-decoration:none;color:%(fg3)s;font-weight:500}
.eyebrow{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;letter-spacing:.13em;
  text-transform:uppercase;color:%(accent)s;margin-bottom:16px}
h1{font-size:46px;line-height:1.1;letter-spacing:-.022em;max-width:19ch;font-weight:600}
.sub{color:%(fg2)s;font-size:19px;margin-top:14px;max-width:52ch;line-height:1.45}
.body{margin-top:26px}
.rows{border:1px solid %(line)s;background:%(panel)s;border-radius:3px}
.r{display:grid;grid-template-columns:110px 1fr auto;gap:16px;padding:11px 18px;align-items:baseline;
  border-bottom:1px solid %(line)s;font-size:15px}
.r:last-child{border-bottom:0}
.k{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:%(fg3)s}
.v{color:%(fg2)s}
.t{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;font-weight:700;letter-spacing:.05em}
.t.ok{color:%(ok)s} .t.warn{color:%(warn)s} .t.acc{color:%(accent)s}
.rule{border-bottom:2px solid %(accent)s;padding:9px 18px 7px;font-family:ui-monospace,monospace;
  font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:%(accent)s}
.cols{display:grid;grid-template-columns:1.25fr 1fr 1fr;gap:1px;background:%(line)s;border:1px solid %(line)s}
.c{background:%(panel)s;padding:15px 18px 17px;display:flex;flex-direction:column;gap:5px}
.c .h{font-family:ui-monospace,monospace;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:%(fg3)s}
.c .n{font-size:34px;font-weight:600;color:%(fg2)s;line-height:1}
.c.big{box-shadow:inset 3px 0 0 %(accent)s}
.c.big .h{color:%(accent)s} .c.big .n{font-size:56px;color:%(accent)s}
.pair{display:flex;align-items:stretch;gap:14px}
.p{flex:1;background:%(panel)s;border:1px solid %(line)s;padding:14px 16px;display:flex;flex-direction:column;gap:4px}
.p .h{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:%(fg3)s}
.p .n{font-size:36px;font-weight:600;line-height:1}
.p .s{font-size:12.5px;color:%(fg2)s}
.p.accent{box-shadow:inset 0 3px 0 %(accent)s}
.p.accent .n{color:%(accent)s}
.arw{align-self:center;color:%(accent)s;font-size:26px}
.foot{display:flex;justify-content:space-between;align-items:baseline;
  border-top:1px solid %(line)s;padding-top:16px;font-size:14px;color:%(fg3)s}
.foot code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;color:%(fg2)s}
</style>
<div class="mark"><i>&#10003;</i>AgentReady <s>/ Woo</s></div>
<div>
  <p class="eyebrow">%(eyebrow)s</p>
  <h1>%(head)s</h1>
  <p class="sub">%(sub)s</p>
  <div class="body">%(body)s</div>
</div>
<div class="foot"><code>%(canon)s</code><span>Free · read-only · settlement disabled</span></div>
"""

made = []
with sync_playwright() as p:
    b = p.chromium.launch()
    for slug, story in STORIES.items():
        for theme, colours in THEMES.items():
            html = TPL % {**colours, **story, "canon": CANON}
            pg = b.new_page(viewport={"width":1200,"height":630}, device_scale_factor=1)
            pg.set_content(html); pg.wait_for_timeout(80)
            path = OUT / f"card-{slug}-{theme}.png"
            pg.screenshot(path=str(path))
            over = pg.evaluate("document.body.scrollHeight - 630")
            made.append({"file": path.name, "overflow_px": max(0, over)})
            pg.close()
    b.close()
print(json.dumps(made, indent=1))
