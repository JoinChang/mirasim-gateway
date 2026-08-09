CREATE TABLE `model_status` (
	`model` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'unknown' NOT NULL,
	`last_status` integer DEFAULT 0 NOT NULL,
	`last_checked_at` integer DEFAULT 0 NOT NULL,
	`last_ok_at` integer DEFAULT 0 NOT NULL,
	`served_model` text,
	`consecutive_fails` integer DEFAULT 0 NOT NULL
);
