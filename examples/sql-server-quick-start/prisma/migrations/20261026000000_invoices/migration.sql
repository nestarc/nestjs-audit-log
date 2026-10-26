CREATE TABLE [dbo].[audit_demo_invoices] (
  [id] NVARCHAR(80) NOT NULL,
  [tenantId] NVARCHAR(80) NOT NULL,
  [status] NVARCHAR(40) NOT NULL,
  CONSTRAINT [audit_demo_invoices_pkey] PRIMARY KEY ([id])
);
