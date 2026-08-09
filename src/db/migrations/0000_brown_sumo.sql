CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`plan` text DEFAULT '' NOT NULL,
	`refresh_token` text NOT NULL,
	`device_private_key` text,
	`disabled_until` integer DEFAULT 0 NOT NULL,
	`consecutive_fails` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer DEFAULT 0 NOT NULL,
	`last_utilization` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`actor` text DEFAULT 'cli' NOT NULL,
	`action` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `downstream_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`rpm_limit` integer,
	`daily_token_limit` integer,
	`last_used_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `downstream_keys_key_hash_unique` ON `downstream_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`downstream_key_id` text,
	`account_id` text,
	`dialect` text NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`web_search_requests` integer DEFAULT 0 NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`via_relay` integer DEFAULT 0 NOT NULL,
	`cost` real,
	`latency_ms` integer DEFAULT 0 NOT NULL
);
