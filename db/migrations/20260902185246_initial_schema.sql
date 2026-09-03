-- The initial schema. MySQL is the system of record.
--
-- Normalised rather than a single JSON blob per product, because the relational shape is what
-- makes the non-search questions cheap: "how many products per category", "which products carry
-- this tag", "average rating per product". Elasticsearch holds the denormalised copy for search.
--
-- Applied by the seed script rather than docker-entrypoint-initdb.d: that directory only runs on
-- a first-time init of an empty data volume, so a schema change would silently not apply to
-- anyone who already had the volume. Running it from the script makes it reproducible.
--
-- Every up statement is idempotent, which is what lets the seed re-apply the directory without a
-- ledger. Keep it that way in later migrations, or the runner will need one.

-- migrate:up

CREATE TABLE IF NOT EXISTS categories (
    id         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    slug       VARCHAR(120)    NOT NULL,
    name       VARCHAR(160)    NOT NULL,
    url        VARCHAR(512)    NULL,
    created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    -- The slug is the natural key the source uses; the surrogate id keeps foreign keys narrow.
    UNIQUE KEY uq_categories_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
    -- The source's own id is kept as the primary key: it is stable, and reusing it means a
    -- re-seed updates rows in place instead of duplicating the catalogue.
    id                      INT UNSIGNED   NOT NULL,
    title                   VARCHAR(255)   NOT NULL,
    description             TEXT           NULL,
    category_id             INT UNSIGNED   NULL,
    brand                   VARCHAR(160)   NULL,
    sku                     VARCHAR(64)    NULL,
    -- DECIMAL, not FLOAT: money compared or summed in binary floating point drifts, and a
    -- price is exactly the column where that shows up in a report.
    price                   DECIMAL(10,2)  NOT NULL DEFAULT 0.00,
    discount_percentage     DECIMAL(5,2)   NULL,
    rating                  DECIMAL(3,2)   NULL,
    stock                   INT            NOT NULL DEFAULT 0,
    weight                  DECIMAL(10,2)  NULL,
    -- Dimensions are 1:1 and always present, so inline columns beat a joined table that could
    -- only ever hold one row per product.
    dim_width               DECIMAL(10,2)  NULL,
    dim_height              DECIMAL(10,2)  NULL,
    dim_depth               DECIMAL(10,2)  NULL,
    warranty_information    VARCHAR(255)   NULL,
    shipping_information    VARCHAR(255)   NULL,
    availability_status     VARCHAR(64)    NULL,
    return_policy           VARCHAR(255)   NULL,
    minimum_order_quantity  INT            NULL,
    thumbnail               VARCHAR(512)   NULL,
    meta_barcode            VARCHAR(64)    NULL,
    meta_qr_code            VARCHAR(512)   NULL,
    meta_created_at         DATETIME       NULL,
    meta_updated_at         DATETIME       NULL,
    created_at              TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_products_category (category_id),
    KEY idx_products_price (price),
    KEY idx_products_rating (rating),
    KEY idx_products_brand (brand),
    -- ON DELETE SET NULL, not CASCADE: removing a category should orphan its products for
    -- re-filing, never delete the catalogue.
    CONSTRAINT fk_products_category FOREIGN KEY (category_id)
        REFERENCES categories (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_images (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_id INT UNSIGNED    NOT NULL,
    url        VARCHAR(512)    NOT NULL,
    -- Gallery order is meaningful (image 1 is the hero shot), and row order in SQL is not.
    position   SMALLINT        NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uq_product_images (product_id, position),
    CONSTRAINT fk_product_images_product FOREIGN KEY (product_id)
        REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tags (
    id   INT UNSIGNED NOT NULL AUTO_INCREMENT,
    slug VARCHAR(120) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_tags_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Many-to-many: a tag belongs to many products and vice versa. The composite primary key is the
-- join's natural key, so no surrogate id and no chance of a duplicate pairing.
CREATE TABLE IF NOT EXISTS product_tags (
    product_id INT UNSIGNED NOT NULL,
    tag_id     INT UNSIGNED NOT NULL,
    PRIMARY KEY (product_id, tag_id),
    KEY idx_product_tags_tag (tag_id),
    CONSTRAINT fk_product_tags_product FOREIGN KEY (product_id)
        REFERENCES products (id) ON DELETE CASCADE,
    CONSTRAINT fk_product_tags_tag FOREIGN KEY (tag_id)
        REFERENCES tags (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_reviews (
    id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_id     INT UNSIGNED    NOT NULL,
    rating         TINYINT         NOT NULL,
    comment        TEXT            NULL,
    review_date    DATETIME        NULL,
    reviewer_name  VARCHAR(160)    NULL,
    reviewer_email VARCHAR(255)    NULL,
    PRIMARY KEY (id),
    KEY idx_product_reviews_product (product_id),
    -- The source gives reviews no id of their own, so a re-seed replaces a product's reviews
    -- wholesale (see the seed script) rather than trying to match them up.
    CONSTRAINT fk_product_reviews_product FOREIGN KEY (product_id)
        REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down

-- Reverse dependency order: a table cannot be dropped while a foreign key still points at it.
DROP TABLE IF EXISTS product_reviews;
DROP TABLE IF EXISTS product_tags;
DROP TABLE IF EXISTS product_images;
DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
