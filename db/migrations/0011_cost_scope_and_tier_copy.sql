-- 0011_cost_scope_and_tier_copy.sql
-- What a per-square-foot price does and does not cover.
--
-- The kickoff's purpose for the cost estimate is "to give a client a rough,
-- honest number so they are not shocked when real bids come back." A total
-- shown on its own is not that number: Marco's own client guide is explicit
-- that land, site work, design, permits and a 10-20% contingency are all
-- billed separately. Showing a build cost without that boundary invites
-- exactly the surprise the tool exists to prevent.
--
-- Scope lives on the cost model (not in application code) so a town can
-- override it, matching "cost is data, never hardcode it". The seeded values
-- are Marco Design's standard scope, from their published client guide.
--
-- Nothing proprietary is stored here: no rates, no tier figures, no
-- estimating methodology -- only the scope boundary and the client-facing
-- level descriptions from a handout Marco gives clients directly.

ALTER TABLE build_cost_models ADD COLUMN IF NOT EXISTS cost_scope jsonb;

UPDATE build_cost_models
SET cost_scope = jsonb_build_object(
    'includes', jsonb_build_array(
        'Foundation, framing, roof, and exterior',
        'Windows, exterior doors, and insulation',
        'Plumbing, electrical, and HVAC systems',
        'Interior finishes, fixtures, and standard appliances',
        'Builder overhead and project management'
    ),
    'excludes', jsonb_build_array(
        'Land purchase',
        'Site work: clearing, excavation, utilities, septic / well, driveway',
        'Architectural design and engineering',
        'Survey, soil testing, permits, and impact fees'
    ),
    'contingency_pct', jsonb_build_object('min', 10, 'max', 20)
)
WHERE cost_scope IS NULL;

-- Client-facing description of each build level, so the tiers are more than
-- three prices. Only fills blanks -- an operator's own wording always wins.
UPDATE build_cost_tiers SET notes =
    'First builds, rental and investment homes, and buyers who want quality '
    'without a custom price tag. Efficient plans, stock cabinetry, quartz or '
    'laminate counters, luxury-vinyl or tile floors, standard fixtures, and a '
    'builder appliance package.'
WHERE tier = 'essential' AND (notes IS NULL OR notes = '');

UPDATE build_cost_tiers SET notes =
    'Our most popular level - families who want a semi-custom home with real '
    'character and upgraded materials. Custom cabinetry, stone or quartz '
    'counters, tile and engineered-wood floors, upgraded lighting and '
    'fixtures, and designer detailing throughout.'
WHERE tier = 'signature' AND (notes IS NULL OR notes = '');

UPDATE build_cost_tiers SET notes =
    'Fully custom homes designed around you, with premium materials and more '
    'complex architecture. Designer kitchens and baths, natural stone and '
    'hardwood, high ceilings, custom millwork, smart-home systems, and luxury '
    'appliance packages.'
WHERE tier = 'premium' AND (notes IS NULL OR notes = '');
