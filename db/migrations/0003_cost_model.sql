-- 0003_cost_model.sql
-- Tiered build-cost rates, one model per municipality, sitting in the same
-- config the zoning came from -- never hardcoded in application code.
--
-- The whole product promise here is honesty: every rate carries a provenance
-- flag the client can see.
--   verified  -> Marco Design's real figures for a town they build in.
--                baseline/factor are NULL; the tier rate is authoritative.
--   estimated -> derived from a regional baseline * local cost factor for a
--                town they have no figures for. The UI shows a caveat.
--
-- We keep baseline + factor on the model (not just the final rate) so an
-- estimated model is reproducible and auditable: you can see how the number
-- was derived, not just the result.

CREATE TABLE IF NOT EXISTS build_cost_models (
    id                          serial PRIMARY KEY,
    municipality_id             integer NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,
    provenance                  text NOT NULL CHECK (provenance IN ('verified', 'estimated')),

    -- Populated for estimated models, NULL for verified ones.
    regional_baseline_per_sqft  numeric,
    local_cost_factor           numeric,

    effective_date              date NOT NULL DEFAULT current_date,
    UNIQUE (municipality_id),

    -- Enforce the provenance contract at the DB level:
    -- estimated models must carry their derivation; verified must not.
    CONSTRAINT provenance_fields CHECK (
        (provenance = 'estimated'
            AND regional_baseline_per_sqft IS NOT NULL
            AND local_cost_factor IS NOT NULL)
        OR
        (provenance = 'verified'
            AND regional_baseline_per_sqft IS NULL
            AND local_cost_factor IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS build_cost_tiers (
    id                  serial PRIMARY KEY,
    cost_model_id       integer NOT NULL REFERENCES build_cost_models(id) ON DELETE CASCADE,
    tier                text NOT NULL CHECK (tier IN ('builder_grade', 'mid_level', 'high_end')),
    rate_per_sqft       numeric NOT NULL CHECK (rate_per_sqft >= 0),
    -- Mirrors the model's provenance; denormalized so the API can label a
    -- single tier without joining back up.
    provenance          text NOT NULL CHECK (provenance IN ('verified', 'estimated')),
    -- e.g. 'regional_baseline * local_factor * 1.40' or 'authoritative_historical_rate'
    formula_reference   text,
    UNIQUE (cost_model_id, tier)
);
