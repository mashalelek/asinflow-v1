-- ============================================================================
-- AsinFlow schema baseline — generated 2026-10-15 (SPEC §24 "Migrations",
-- patch docs/claude_spec-patch-migration-runner.md, decision B)
-- ============================================================================
--
-- WHAT THIS IS. The live schema as of 2026-10-15, captured with
--   pg_dump --schema-only --no-owner --no-privileges asinflow
-- then edited only to remove pg_dump's `\restrict` / `\unrestrict` psql
-- meta-commands and its `set_config('search_path', '', false)` line, so the
-- file executes as plain SQL through the runner (server/migrate.ts) and
-- leaves the session's search_path alone for the files that follow.
--
-- HOW IT IS USED. On an EMPTY database (no `asins` table) the runner applies
-- this file first, records it as ledger version 0, marks every migration file
-- numbered <= 050 as applied (they are all already contained here), then
-- applies 051 and up normally. On an EXISTING database it is never executed;
-- the runner only records version 0 in the ledger.
--
-- WHY A NEW BASELINE. The previous base file, now at
-- database/archive/asinflow_schema_v1.1.sql, plus migrations 001..050 do NOT
-- reproduce the live schema. Trialled 2026-10-15 in a scratch database:
--   * 002, 016 fail: `asins.is_hazmat` is created by no file;
--   * 041 fails: `asin_estimates.error` is created by no file;
--   * `asin_estimates` live has an integer id, `asin` varchar as the key, and
--     estimated_cogs / actual_cogs / fees_estimate_price / error /
--     ordered_qty / storage_override ...; v1.1 has a uuid id, `asin_id`, and
--     est_* columns that never existed live;
--   * `asin_estimates_history` (33,146 rows, read by GET /api/asins) is
--     created by no file;
--   * `asins.is_hazmat`, `is_dangerous_good`, `is_wholesale`, `is_oa`,
--     `is_search_suppressed`, `suppression_reasons`, `last_reviewed_at`
--     are created by no file.
-- Those were applied by hand before the migration files existed and never
-- captured. This file is the capture. Nothing here is hand-edited beyond the
-- two removals above; regenerate the same way if it ever has to change, and
-- bump the date in the name.
--
-- REGENERATING. Only when a new baseline is deliberately cut (not for every
-- migration — forward migrations are 0NN_*.sql files). Then update
-- BASELINE_FILE in server/migrate.ts and move this file to database/archive/.
-- ============================================================================

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.13 (Homebrew)
-- Dumped by pg_dump version 16.13 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: asin_estimates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asin_estimates (
    id integer NOT NULL,
    asin character varying(20) NOT NULL,
    cogs numeric,
    prep_override numeric,
    storage_override numeric,
    lowest_fba_price numeric,
    buy_box_price numeric,
    buy_box_fulfillment text,
    lowest_price numeric,
    sellers_fba integer,
    sellers_fbm integer,
    fba_fee numeric,
    referral_fee numeric,
    fees_estimate_price numeric,
    bsr integer,
    bsr_category text,
    eligibility_status text,
    error text,
    fetched_at timestamp without time zone DEFAULT now(),
    cogs_source text,
    ordered_qty numeric DEFAULT 0,
    actual_cogs numeric(10,2),
    estimated_cogs numeric(10,2),
    estimated_cogs_source character varying(20),
    fee_source character varying(10),
    CONSTRAINT asin_estimates_cogs_source_check CHECK ((cogs_source = ANY (ARRAY['po_sheet'::text, 'manual'::text]))),
    CONSTRAINT asin_estimates_estimated_cogs_source_check CHECK (((estimated_cogs_source)::text = ANY ((ARRAY['manual'::character varying, 'po_sheet'::character varying, 'csv'::character varying])::text[]))),
    CONSTRAINT asin_estimates_fee_source_check CHECK (((fee_source)::text = ANY ((ARRAY['spapi'::character varying, 'fallback'::character varying])::text[])))
);


--
-- Name: asin_estimates_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asin_estimates_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    asin_id uuid NOT NULL,
    sellers_fba integer,
    sellers_fbm integer,
    sale_price numeric(10,2),
    bsr integer,
    fetched_at timestamp with time zone DEFAULT now()
);


--
-- Name: asin_estimates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.asin_estimates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asin_estimates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.asin_estimates_id_seq OWNED BY public.asin_estimates.id;


--
-- Name: asin_skus; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asin_skus (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    asin_id uuid NOT NULL,
    sku character varying(50) NOT NULL,
    is_primary boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: asin_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asin_tags (
    asin_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    applied_at timestamp with time zone DEFAULT now()
);


--
-- Name: asins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asins (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    asin character varying(10) NOT NULL,
    primary_sku character varying(50),
    title text,
    image_url text,
    brand character varying(255),
    category character varying(255),
    weight_lb numeric(10,4),
    length_in numeric(8,3),
    width_in numeric(8,3),
    height_in numeric(8,3),
    size_tier character varying(50),
    buy_link text,
    supplier character varying(255),
    in_catalog boolean DEFAULT false,
    fulfillment_channel character varying(10) DEFAULT 'FBA'::character varying,
    is_meltable boolean DEFAULT false,
    notes text,
    added_at timestamp with time zone DEFAULT now(),
    last_refreshed_at timestamp with time zone,
    is_hazmat boolean,
    is_search_suppressed boolean DEFAULT false,
    suppression_reasons jsonb,
    last_reviewed_at timestamp with time zone,
    is_wholesale boolean DEFAULT false,
    is_oa boolean DEFAULT false,
    is_catalog_deleted boolean DEFAULT false NOT NULL,
    catalog_checked_at timestamp with time zone,
    is_dangerous_good boolean,
    has_live_offer boolean,
    offer_checked_at timestamp with time zone,
    promo_notes text,
    current_issues jsonb,
    issues_checked_at timestamp with time zone,
    supplier_sku character varying(100),
    status text DEFAULT 'active'::text NOT NULL,
    status_reason text,
    status_changed_at timestamp with time zone,
    gating_checked_at timestamp with time zone,
    hazmat_checked_at timestamp with time zone,
    has_buyable_offer boolean,
    buyable_checked_at timestamp with time zone,
    lead_source text,
    CONSTRAINT asins_fulfillment_channel_check CHECK (((fulfillment_channel)::text = ANY ((ARRAY['FBA'::character varying, 'FBM'::character varying])::text[]))),
    CONSTRAINT asins_lead_source_check CHECK ((lead_source = ANY (ARRAY['ER'::text, 'Spark'::text, 'OA Hunt'::text, 'OAL 24/7'::text, 'MP'::text, 'RA'::text]))),
    CONSTRAINT asins_status_check CHECK ((status = ANY (ARRAY['active'::text, 'parked'::text, 'dead'::text])))
);


--
-- Name: COLUMN asins.is_hazmat; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.asins.is_hazmat IS 'FBA hazmat (storage/handling): INBOUND eligibility code FBA_INB_0015. NULL = not yet checked. KNOWN LIMITATION: 0015 proven only for compressed-gas hazmat; other classes unanchored, read false until validated (see server/hazmat-classify.ts + docs/SPEC.md).';


--
-- Name: COLUMN asins.is_catalog_deleted; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.asins.is_catalog_deleted IS 'getCatalogItem returned 404 (product record gone from Amazon catalog). Reversible — flips back to false on next 200. Owned by analyze path per SPEC §14. NOT a general "deactivated" flag.';


--
-- Name: COLUMN asins.catalog_checked_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.asins.catalog_checked_at IS 'Timestamp of the most recent getCatalogItem call that set is_catalog_deleted.';


--
-- Name: COLUMN asins.is_dangerous_good; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.asins.is_dangerous_good IS 'DG transport classification: getCatalogItem attributes.hazmat present/non-empty. NULL = not yet checked. Drives the DG-attribute gate (live-derived at offer-add) and the DG surcharge.';


--
-- Name: COLUMN asins.promo_notes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.asins.promo_notes IS 'Promo/coupon/gift-card notes from sourcing sheet Col O ("Coupons/Gift Cards/Sales"). User-controlled (§14): written on the new-ASIN INSERT branch only; analyze and re-sync never overwrite.';


--
-- Name: brand_product_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brand_product_registry (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    brand_code character varying(3) NOT NULL,
    nnn smallint NOT NULL,
    ttl character varying(3) NOT NULL,
    dept_code character varying(3) NOT NULL,
    product_name text,
    first_asin character varying(10),
    registered_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT brand_product_registry_brand_code_check CHECK (((brand_code)::text ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT brand_product_registry_dept_code_check CHECK (((dept_code)::text ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT brand_product_registry_nnn_check CHECK (((nnn >= 1) AND (nnn <= 999))),
    CONSTRAINT brand_product_registry_ttl_check CHECK (((ttl)::text ~ '^[A-Z]{3}$'::text))
);


--
-- Name: TABLE brand_product_registry; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.brand_product_registry IS 'Product identity within a brand: (brand_code, nnn) → ttl. UNIQUE key is (brand_code, nnn). dept_code is informational only, NOT part of the key and NOT validated on reuse — the same product can appear under different Amazon depts across ASINs because each listing carries its own dept from Amazon catalog data.';


--
-- Name: COLUMN brand_product_registry.dept_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.brand_product_registry.dept_code IS 'Informational: dept of the FIRST ASIN that registered this product. Not part of the unique key. Not validated on reuse — operators can submit the same NNN/TTL against a new ASIN with a different dept (Amazon categorizes the same product differently across ASINs).';


--
-- Name: bulk_gating_hazmat_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bulk_gating_hazmat_cache (
    asin character varying(10) NOT NULL,
    eligibility_status text,
    is_hazmat boolean,
    gating_checked_at timestamp with time zone,
    hazmat_checked_at timestamp with time zone
);


--
-- Name: bulk_list_asins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bulk_list_asins (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    list_id uuid NOT NULL,
    asin character varying(10) NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    title text,
    image_url text,
    brand character varying(255),
    category character varying(255),
    weight_lb numeric(10,4),
    length_in numeric(8,3),
    width_in numeric(8,3),
    height_in numeric(8,3),
    sale_price numeric(10,2),
    fba_fee numeric(10,2),
    referral_fee numeric(10,2),
    variable_closing_fee numeric(10,2),
    fees_estimate_price numeric(10,2),
    bsr integer,
    sellers_fba integer,
    sellers_fbm integer,
    estimated_cogs numeric(10,2),
    estimated_cogs_source character varying(10),
    eligibility_status text,
    is_meltable boolean DEFAULT false NOT NULL,
    is_hazmat boolean,
    is_dangerous_good boolean,
    error text,
    fetched_at timestamp with time zone,
    supplier_sku character varying(100),
    buy_link text,
    supplier character varying(255),
    tags text[],
    promo_notes text,
    notes text,
    catalog_outcome text,
    price_outcome text,
    sale_price_buy_box numeric(10,2),
    sale_price_lowest numeric(10,2),
    last_reviewed_at timestamp with time zone,
    lead_source text,
    CONSTRAINT bulk_list_asins_estimated_cogs_source_check CHECK (((estimated_cogs_source)::text = ANY ((ARRAY['csv'::character varying, 'manual'::character varying])::text[]))),
    CONSTRAINT bulk_list_asins_lead_source_check CHECK ((lead_source = ANY (ARRAY['ER'::text, 'Spark'::text, 'OA Hunt'::text, 'OAL 24/7'::text, 'MP'::text, 'RA'::text])))
);


--
-- Name: bulk_lists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bulk_lists (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(200) NOT NULL,
    source_filename character varying(255),
    asin_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: inventory_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_snapshots (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    asin_id uuid NOT NULL,
    available_fba integer DEFAULT 0,
    reserved integer DEFAULT 0,
    inbound_shipped integer DEFAULT 0,
    inbound_receiving integer DEFAULT 0,
    available_fbm integer DEFAULT 0,
    ordered_qty integer DEFAULT 0,
    total_inventory_position integer GENERATED ALWAYS AS ((((((COALESCE(available_fba, 0) + COALESCE(available_fbm, 0)) + COALESCE(reserved, 0)) + COALESCE(inbound_shipped, 0)) + COALESCE(inbound_receiving, 0)) + COALESCE(ordered_qty, 0))) STORED,
    snapshot_at timestamp with time zone DEFAULT now()
);


--
-- Name: listing_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_submissions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    asin character varying(10) NOT NULL,
    sku character varying(50) NOT NULL,
    submission_id text,
    submitted_price numeric(10,2),
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    verify_status text DEFAULT 'pending'::text NOT NULL,
    verified_at timestamp with time zone,
    verdict_source text,
    issues jsonb,
    review_flags text[] DEFAULT '{}'::text[] NOT NULL,
    terminal_conflict boolean DEFAULT false NOT NULL,
    flags_acknowledged_at timestamp with time zone,
    price_source text,
    price_detail text,
    anchor_offer_price numeric(10,2),
    anchor_offer_feedback integer,
    cpt_seen numeric(10,2),
    resulting_roi numeric(8,2),
    price_warning text,
    qualified_offer_count integer,
    disqualified_offers jsonb,
    CONSTRAINT listing_submissions_verdict_source_check CHECK ((verdict_source = ANY (ARRAY['api'::text, 'manual'::text]))),
    CONSTRAINT listing_submissions_verify_status_check CHECK ((verify_status = ANY (ARRAY['pending'::text, 'processing'::text, 'live'::text, 'failed'::text, 'stale'::text, 'deleted'::text])))
);


--
-- Name: TABLE listing_submissions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.listing_submissions IS 'Post-submit verification ledger. One row per putListingsItem fire. Verify sweep resolves verify_status against SC; ACCEPTED is never rendered as CREATED.';


--
-- Name: COLUMN listing_submissions.price_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.listing_submissions.price_source IS 'Which §18 v2 path set the price: fba_anchor | roi_40_floor | roi_60_solve.';


--
-- Name: COLUMN listing_submissions.cpt_seen; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.listing_submissions.cpt_seen IS 'CompetitivePriceThreshold observed at submit time. Recorded for analysis ONLY — §18 v2 never uses CPT as a pricing input.';


--
-- Name: po_asins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.po_asins (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    po_id uuid NOT NULL,
    asin character varying(10) NOT NULL,
    asin_name text,
    sku character varying(50),
    qty integer DEFAULT 0 NOT NULL,
    cost_per_unit numeric(10,2),
    prep_cost numeric(10,2) DEFAULT 0,
    sold_as text DEFAULT 'individual'::text,
    units_per_pack integer DEFAULT 1,
    unreimbursed_loss_qty integer DEFAULT 0,
    unreimbursed_loss_amount numeric(10,2) DEFAULT 0,
    notes text,
    CONSTRAINT po_asins_sold_as_check CHECK ((sold_as = ANY (ARRAY['individual'::text, 'multi-pack'::text, 'bundle'::text])))
);


--
-- Name: po_line_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.po_line_items (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    po_id uuid NOT NULL,
    po_asin_id uuid,
    "position" integer,
    product_name text,
    supplier_sku text,
    price numeric(10,2),
    item_discount numeric(10,2) DEFAULT 0,
    qty_ordered integer,
    qty_received integer,
    qty_returned integer DEFAULT 0,
    asin_qty_per_product numeric(8,2) DEFAULT 1,
    adjusted_product_cost numeric(10,2),
    notes text,
    qty_canceled integer,
    final_qty integer GENERATED ALWAYS AS (((qty_ordered - qty_canceled) - qty_returned)) STORED
);


--
-- Name: purchase_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_orders (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    order_id text NOT NULL,
    order_date date NOT NULL,
    supplier text NOT NULL,
    status text DEFAULT 'Ordered'::text NOT NULL,
    subtotal numeric(12,2) DEFAULT 0,
    tax numeric(12,2) DEFAULT 0,
    sh_donations numeric(12,2) DEFAULT 0,
    discount numeric(12,2) DEFAULT 0,
    refund_amount numeric(12,2) DEFAULT 0,
    order_total numeric(12,2) DEFAULT 0,
    payment_method text,
    weighted_gc_discount_pct numeric(6,2),
    promo text,
    cashback_site text,
    cashback_pct numeric(6,2),
    purchased_by text,
    subscription boolean DEFAULT false,
    email_used text,
    invoice_attached boolean DEFAULT false,
    notes text,
    source text DEFAULT 'manual'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT purchase_orders_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'sheet_import'::text])))
);


--
-- Name: refresh_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_runs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    trigger character varying(32) NOT NULL,
    stage character varying(20) NOT NULL,
    scope text NOT NULL,
    requested integer DEFAULT 0 NOT NULL,
    counts jsonb,
    outcomes jsonb,
    rate_limit_stats jsonb,
    error text,
    CONSTRAINT refresh_runs_scope_check CHECK (((scope = ANY (ARRAY['full'::text, 'subset'::text])) OR (scope ~~ 'bulk:%'::text))),
    CONSTRAINT refresh_runs_trigger_check CHECK (((trigger)::text = ANY (ARRAY[('manual'::character varying)::text, ('refresh'::character varying)::text, ('cron'::character varying)::text, ('sourcing'::character varying)::text, ('upload'::character varying)::text, ('extension'::character varying)::text, ('backfill'::character varying)::text, ('sc_discovery'::character varying)::text])))
);


--
-- Name: sales_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_daily (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    asin_id uuid NOT NULL,
    sale_date date NOT NULL,
    units_sold integer DEFAULT 0,
    revenue numeric(12,2) DEFAULT 0,
    units_refunded integer DEFAULT 0,
    refund_amount numeric(12,2) DEFAULT 0,
    actual_fba_fees numeric(12,2) DEFAULT 0,
    actual_referral_fees numeric(12,2) DEFAULT 0,
    actual_other_fees numeric(12,2) DEFAULT 0,
    synced_at timestamp with time zone DEFAULT now()
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    sid text NOT NULL,
    sess jsonb NOT NULL,
    expire timestamp with time zone NOT NULL
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    key character varying(100) NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: sku_legend; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sku_legend (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    type character varying(10) NOT NULL,
    raw_value text NOT NULL,
    code character(3) NOT NULL,
    status character varying(10) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_at timestamp with time zone,
    note text,
    CONSTRAINT sku_legend_status_check CHECK (((status)::text = ANY ((ARRAY['approved'::character varying, 'proposed'::character varying])::text[]))),
    CONSTRAINT sku_legend_type_check CHECK (((type)::text = ANY ((ARRAY['brand'::character varying, 'dept'::character varying])::text[])))
);


--
-- Name: TABLE sku_legend; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sku_legend IS 'Authoritative brand/dept/sub → 3-char code map. status=approved is user-blessed; proposed=algorithmic suggestion awaiting approval. Resurrection must use approved codes; proposed ones surface for review before SKU commit.';


--
-- Name: sku_legend_alias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sku_legend_alias (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    legend_id uuid NOT NULL,
    raw_value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    note text
);


--
-- Name: TABLE sku_legend_alias; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sku_legend_alias IS 'Spelling variants that map to a canonical sku_legend row. Created at brand-approval time. Resolver MUST lookup via this table (not sku_legend.raw_value directly) so aliases work.';


--
-- Name: COLUMN sku_legend_alias.note; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sku_legend_alias.note IS 'Informational only (e.g. "self-alias backfilled", "merged from pending approval on YYYY-MM-DD"). Never used as a resolution key.';


--
-- Name: sourcing_cost_exports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sourcing_cost_exports (
    id integer NOT NULL,
    filename text NOT NULL,
    range_start date NOT NULL,
    range_end date NOT NULL,
    purchased_asins integer DEFAULT 0 NOT NULL,
    asins_written integer DEFAULT 0 NOT NULL,
    rows_written integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: sourcing_cost_exports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sourcing_cost_exports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sourcing_cost_exports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sourcing_cost_exports_id_seq OWNED BY public.sourcing_cost_exports.id;


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) NOT NULL,
    color character varying(7),
    created_at timestamp with time zone DEFAULT now(),
    tag_group character varying(50),
    sort_order integer
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    email text NOT NULL,
    display_name text NOT NULL,
    password_hash text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    failed_logins integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text])))
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: velocity_bundle_identity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.velocity_bundle_identity (
    velocity_order_id text NOT NULL,
    asin text NOT NULL,
    child_order_numbers text[] NOT NULL,
    child_order_ids text[],
    source text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT velocity_bundle_identity_source_check CHECK ((source = ANY (ARRAY['observed'::text, 'manual_seed'::text, 'manual_map'::text])))
);


--
-- Name: view_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.view_presets (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    config jsonb NOT NULL,
    is_default boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: asin_estimates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asin_estimates ALTER COLUMN id SET DEFAULT nextval('public.asin_estimates_id_seq'::regclass);


--
-- Name: sourcing_cost_exports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sourcing_cost_exports ALTER COLUMN id SET DEFAULT nextval('public.sourcing_cost_exports_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: asin_estimates asin_estimates_asin_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asin_estimates
    ADD CONSTRAINT asin_estimates_asin_key UNIQUE (asin);


--
-- Name: asin_estimates_history asin_estimates_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asin_estimates_history
    ADD CONSTRAINT asin_estimates_history_pkey PRIMARY KEY (id);


--
-- Name: asin_estimates asin_estimates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asin_estimates
    ADD CONSTRAINT asin_estimates_pkey PRIMARY KEY (id);


--
-- Name: asin_skus asin_skus_asin_id_sku_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asin_skus
    ADD CONSTRAINT asin_skus_asin_id_sku_key UNIQUE (asin_id, sku);


--
-- Name: asin_skus asin_skus_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asin_skus
    ADD CONSTRAINT asin_skus_pkey PRIMARY KEY (id);


--
-- Name: asin_tags asin_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asin_tags
    ADD CONSTRAINT asin_tags_pkey PRIMARY KEY (asin_id, tag_id);


--
-- Name: asins asins_asin_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asins
    ADD CONSTRAINT asins_asin_key UNIQUE (asin);


--
-- Name: asins asins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asins
    ADD CONSTRAINT asins_pkey PRIMARY KEY (id);


--
-- Name: brand_product_registry brand_product_registry_brand_code_nnn_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_product_registry
    ADD CONSTRAINT brand_product_registry_brand_code_nnn_key UNIQUE (brand_code, nnn);


--
-- Name: brand_product_registry brand_product_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_product_registry
    ADD CONSTRAINT brand_product_registry_pkey PRIMARY KEY (id);


--
-- Name: bulk_gating_hazmat_cache bulk_gating_hazmat_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_gating_hazmat_cache
    ADD CONSTRAINT bulk_gating_hazmat_cache_pkey PRIMARY KEY (asin);


--
-- Name: bulk_list_asins bulk_list_asins_list_id_asin_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_list_asins
    ADD CONSTRAINT bulk_list_asins_list_id_asin_key UNIQUE (list_id, asin);


--
-- Name: bulk_list_asins bulk_list_asins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_list_asins
    ADD CONSTRAINT bulk_list_asins_pkey PRIMARY KEY (id);


--
-- Name: bulk_lists bulk_lists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_lists
    ADD CONSTRAINT bulk_lists_pkey PRIMARY KEY (id);


--
-- Name: inventory_snapshots inventory_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_snapshots
    ADD CONSTRAINT inventory_snapshots_pkey PRIMARY KEY (id);


--
-- Name: listing_submissions listing_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_submissions
    ADD CONSTRAINT listing_submissions_pkey PRIMARY KEY (id);


--
-- Name: po_asins po_asins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_asins
    ADD CONSTRAINT po_asins_pkey PRIMARY KEY (id);


--
-- Name: po_asins po_asins_po_id_asin_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_asins
    ADD CONSTRAINT po_asins_po_id_asin_key UNIQUE (po_id, asin);


--
-- Name: po_line_items po_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_line_items
    ADD CONSTRAINT po_line_items_pkey PRIMARY KEY (id);


--
-- Name: purchase_orders purchase_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);


--
-- Name: purchase_orders purchase_orders_supplier_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_supplier_order_id_key UNIQUE (supplier, order_id);


--
-- Name: refresh_runs refresh_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_runs
    ADD CONSTRAINT refresh_runs_pkey PRIMARY KEY (id);


--
-- Name: sales_daily sales_daily_asin_id_sale_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_daily
    ADD CONSTRAINT sales_daily_asin_id_sale_date_key UNIQUE (asin_id, sale_date);


--
-- Name: sales_daily sales_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_daily
    ADD CONSTRAINT sales_daily_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (sid);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: sku_legend_alias sku_legend_alias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sku_legend_alias
    ADD CONSTRAINT sku_legend_alias_pkey PRIMARY KEY (id);


--
-- Name: sku_legend sku_legend_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sku_legend
    ADD CONSTRAINT sku_legend_pkey PRIMARY KEY (id);


--
-- Name: sourcing_cost_exports sourcing_cost_exports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sourcing_cost_exports
    ADD CONSTRAINT sourcing_cost_exports_pkey PRIMARY KEY (id);


--
-- Name: tags tags_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_name_key UNIQUE (name);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: velocity_bundle_identity velocity_bundle_identity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.velocity_bundle_identity
    ADD CONSTRAINT velocity_bundle_identity_pkey PRIMARY KEY (velocity_order_id);


--
-- Name: view_presets view_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.view_presets
    ADD CONSTRAINT view_presets_pkey PRIMARY KEY (id);


--
-- Name: asins_lead_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asins_lead_source_idx ON public.asins USING btree (lead_source);


--
-- Name: idx_asins_asin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asins_asin ON public.asins USING btree (asin);


--
-- Name: idx_asins_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asins_status ON public.asins USING btree (status);


--
-- Name: idx_asins_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asins_supplier ON public.asins USING btree (supplier);


--
-- Name: idx_bulk_list_asins_list; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bulk_list_asins_list ON public.bulk_list_asins USING btree (list_id);


--
-- Name: idx_estimates_history_asin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_estimates_history_asin ON public.asin_estimates_history USING btree (asin_id);


--
-- Name: idx_estimates_history_asin_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_estimates_history_asin_date ON public.asin_estimates_history USING btree (asin_id, fetched_at DESC);


--
-- Name: idx_inventory_asin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inventory_asin ON public.inventory_snapshots USING btree (asin_id);


--
-- Name: idx_inventory_latest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inventory_latest ON public.inventory_snapshots USING btree (asin_id, snapshot_at DESC);


--
-- Name: idx_po_asins_asin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_po_asins_asin ON public.po_asins USING btree (asin);


--
-- Name: idx_po_asins_po; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_po_asins_po ON public.po_asins USING btree (po_id);


--
-- Name: idx_po_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_po_date ON public.purchase_orders USING btree (order_date DESC);


--
-- Name: idx_po_lines_po; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_po_lines_po ON public.po_line_items USING btree (po_id);


--
-- Name: idx_po_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_po_supplier ON public.purchase_orders USING btree (supplier);


--
-- Name: idx_refresh_runs_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_runs_started ON public.refresh_runs USING btree (started_at DESC);


--
-- Name: idx_sales_daily_asin_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_daily_asin_date ON public.sales_daily USING btree (asin_id, sale_date);


--
-- Name: idx_sales_daily_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_daily_date ON public.sales_daily USING btree (sale_date);


--
-- Name: idx_sku_legend_alias_legend; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sku_legend_alias_legend ON public.sku_legend_alias USING btree (legend_id);


--
-- Name: idx_sku_legend_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sku_legend_type ON public.sku_legend USING btree (type);


--
-- Name: idx_sourcing_cost_exports_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sourcing_cost_exports_created ON public.sourcing_cost_exports USING btree (created_at DESC);


--
-- Name: idx_velocity_bundle_identity_asin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_velocity_bundle_identity_asin ON public.velocity_bundle_identity USING btree (asin);


--
-- Name: listing_submissions_asin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_submissions_asin_idx ON public.listing_submissions USING btree (asin);


--
-- Name: listing_submissions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_submissions_status_idx ON public.listing_submissions USING btree (verify_status);


--
-- Name: sessions_expire_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expire_idx ON public.sessions USING btree (expire);


--
-- Name: uq_sku_legend_alias_raw; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_sku_legend_alias_raw ON public.sku_legend_alias USING btree (lower(TRIM(BOTH FROM regexp_replace(raw_value, '\s+'::text, ' '::text, 'g'::text))));


--
-- Name: uq_sku_legend_type_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_sku_legend_type_code ON public.sku_legend USING btree (type, code);


--
-- Name: uq_sku_legend_type_raw; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_sku_legend_type_raw ON public.sku_legend USING btree (type, lower(TRIM(BOTH FROM regexp_replace(raw_value, '\s+'::text, ' '::text, 'g'::text))));


--
-- Name: asin_estimates_history asin_estimates_history_asin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asin_estimates_history
    ADD CONSTRAINT asin_estimates_history_asin_id_fkey FOREIGN KEY (asin_id) REFERENCES public.asins(id) ON DELETE CASCADE;


--
-- Name: asin_skus asin_skus_asin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asin_skus
    ADD CONSTRAINT asin_skus_asin_id_fkey FOREIGN KEY (asin_id) REFERENCES public.asins(id) ON DELETE CASCADE;


--
-- Name: asin_tags asin_tags_asin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asin_tags
    ADD CONSTRAINT asin_tags_asin_id_fkey FOREIGN KEY (asin_id) REFERENCES public.asins(id) ON DELETE CASCADE;


--
-- Name: asin_tags asin_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asin_tags
    ADD CONSTRAINT asin_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: bulk_list_asins bulk_list_asins_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_list_asins
    ADD CONSTRAINT bulk_list_asins_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.bulk_lists(id) ON DELETE CASCADE;


--
-- Name: inventory_snapshots inventory_snapshots_asin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_snapshots
    ADD CONSTRAINT inventory_snapshots_asin_id_fkey FOREIGN KEY (asin_id) REFERENCES public.asins(id) ON DELETE CASCADE;


--
-- Name: po_asins po_asins_po_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_asins
    ADD CONSTRAINT po_asins_po_id_fkey FOREIGN KEY (po_id) REFERENCES public.purchase_orders(id) ON DELETE CASCADE;


--
-- Name: po_line_items po_line_items_po_asin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_line_items
    ADD CONSTRAINT po_line_items_po_asin_id_fkey FOREIGN KEY (po_asin_id) REFERENCES public.po_asins(id) ON DELETE SET NULL;


--
-- Name: po_line_items po_line_items_po_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_line_items
    ADD CONSTRAINT po_line_items_po_id_fkey FOREIGN KEY (po_id) REFERENCES public.purchase_orders(id) ON DELETE CASCADE;


--
-- Name: sales_daily sales_daily_asin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_daily
    ADD CONSTRAINT sales_daily_asin_id_fkey FOREIGN KEY (asin_id) REFERENCES public.asins(id) ON DELETE CASCADE;


--
-- Name: sku_legend_alias sku_legend_alias_legend_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sku_legend_alias
    ADD CONSTRAINT sku_legend_alias_legend_id_fkey FOREIGN KEY (legend_id) REFERENCES public.sku_legend(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


