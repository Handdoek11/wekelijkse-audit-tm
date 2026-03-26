-- Switch from weekly to daily data collection
ALTER TABLE weekly_metrics RENAME COLUMN week_start TO date;
