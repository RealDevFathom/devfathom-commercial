SET app.is_platform_admin='true';
UPDATE users SET role='ADMIN' WHERE "organizationId"='org_chai_chowk' AND email='alex@company.com' RETURNING email,role;
INSERT INTO organization_modules (id,"organizationId","moduleId",status,"startsAt","createdAt","updatedAt",reason)
SELECT 'qa_finance_'||key,'org_chai_chowk',id,'ENABLED',now()-interval '1 day',now(),now(),'Disposable finance browser QA fixture' FROM platform_modules WHERE key IN ('pharmacy-core','pharmacy-finance')
ON CONFLICT ("organizationId","moduleId") DO UPDATE SET status='ENABLED',"expiresAt"=NULL;
SELECT m.key,o.status FROM organization_modules o JOIN platform_modules m ON m.id=o."moduleId" WHERE o."organizationId"='org_chai_chowk' AND m.key IN ('pharmacy-core','pharmacy-finance');
