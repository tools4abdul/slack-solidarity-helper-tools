--- Re-open checkouts the Packet Tracker sync gave up on at their first fill.
---
--- The first version treated a packet with Status "Unwalked" and no canvasser
--- as someone else's entry, and marked the checkout as never to be written
--- ("gone"). "Unwalked" with no canvasser is the campaign's default for a
--- packet nobody has taken, so those claims were never recorded. The sync now
--- re-checks a packet that was taken at first fill on every run instead, so
--- these become "taken, already told": filled in once the packet is free, and
--- no second notice to the turf channel.
---
--- Only rows with no cells recorded: a "gone" checkout that had filled in its
--- packet was given up because someone typed over our entry, and stays given
--- up. The first fill only ever writes into a free packet, so this cannot
--- overwrite anyone's entry.
UPDATE `van_turf_checkouts`
   SET `sheet_state` = json_set(json_remove(`sheet_state`, '$.gone'), '$.told', 'taken')
 WHERE json_valid(`sheet_state`)
   AND json_extract(`sheet_state`, '$.gone') = 1
   AND json_extract(`sheet_state`, '$.cells') IS NULL;
