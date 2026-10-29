import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { hash } from 'bcryptjs';
import { config } from 'dotenv';

config({ path: '.env' });
config({ path: '.env.local', override: true });

import { defaultDepartmentRowsForVertical } from '../src/lib/vertical-catalog.js';
import { AGENCY_SUITE_MODULES, syncPlatformCatalog } from './catalog-sync.js';
import { upsertPlatformAdmin } from './platform-admin.js';
import { upsertStagingAdmin } from './staging-admin.js';

// Seed writes through row-level security as a platform admin. Use the migration
// role when it is set so the application role can stay NOSUPERUSER NOBYPASSRLS.
const pool = new pg.Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL?.trim() || process.env.DATABASE_URL,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function seedTenantData(tx: Prisma.TransactionClient) {
  console.log('🌱 Seeding DevFathom database...\n');

  // ============================================
  // USERS — All 8 team members
  // ============================================
  console.log('👥 Creating team members...');
  const seedPassword = process.env.SEED_PASSWORD ?? process.env.ADMIN_PASSWORD;
  if (!seedPassword) {
    throw new Error(
      'Refusing to seed hardcoded credentials. Set SEED_PASSWORD (or ADMIN_PASSWORD) to the password to assign to seeded users.'
    );
  }
  const password = await hash(seedPassword, 12);

  if (
    await tx.invoice.findUnique({
      where: {
        organizationId_invoiceNumber: {
          organizationId: 'org_devfathom',
          invoiceNumber: 'INV-2026-001',
        },
      },
    })
  ) {
    await tx.user.updateMany({
      where: {
        organizationId: 'org_devfathom',
        email: {
          in: [
            'alex@company.com',
            'jordan@company.com',
            'sam@company.com',
            'taylor@company.com',
            'casey@company.com',
            'riley@company.com',
            'morgan@company.com',
            'jamie@company.com',
          ],
        },
      },
      data: { password },
    });
    console.log('  ✓ Seed data already present; refreshed seeded-user credentials\n');
    return;
  }

  const alex = await tx.user.upsert({
    where: {
      organizationId_email: {
        organizationId: 'org_devfathom',
        email: 'alex@company.com',
      },
    },
    update: { password },
    create: {
      name: 'Alex Carter',
      email: 'alex@company.com',
      password,
      role: 'ADMIN',
      department: 'LEADERSHIP',
      title: 'CEO & Founder',
      bio: 'Full Stack Developer and entrepreneur leading the company with a focus on intelligent technology.',
      skills: ['Next.js', 'React', 'Node.js', 'TypeScript', 'PostgreSQL', 'AWS', 'System Design'],
      phone: '+1 (786) 555-0101',
      startDate: new Date('2023-01-01'),
      status: 'ACTIVE',
    },
  });

  const jordan = await tx.user.upsert({
    where: {
      organizationId_email: {
        organizationId: 'org_devfathom',
        email: 'jordan@company.com',
      },
    },
    update: { password },
    create: {
      name: 'Jordan Lee',
      email: 'jordan@company.com',
      password,
      role: 'ADMIN',
      department: 'LEADERSHIP',
      title: 'Co-Founder & Sales Executive',
      bio: 'Driving growth and building lasting client relationships.',
      skills: ['Sales Strategy', 'Client Relations', 'Business Development', 'Product Strategy'],
      phone: '+1 (786) 555-0102',
      startDate: new Date('2023-01-01'),
      status: 'ACTIVE',
    },
  });

  const sam = await tx.user.upsert({
    where: {
      organizationId_email: { organizationId: 'org_devfathom', email: 'sam@company.com' },
    },
    update: { password },
    create: {
      name: 'Sam Patel',
      email: 'sam@company.com',
      password,
      role: 'EMPLOYEE',
      department: 'ENGINEERING',
      title: 'Lead Developer',
      bio: 'Full stack engineer with a passion for clean architecture and scalable solutions.',
      skills: ['React', 'Next.js', 'Node.js', 'Python', 'Docker', 'PostgreSQL', 'Redis'],
      phone: '+1 (786) 555-0103',
      startDate: new Date('2023-03-15'),
      status: 'ACTIVE',
    },
  });

  const taylor = await tx.user.upsert({
    where: {
      organizationId_email: {
        organizationId: 'org_devfathom',
        email: 'taylor@company.com',
      },
    },
    update: { password },
    create: {
      name: 'Taylor Reed',
      email: 'taylor@company.com',
      password,
      role: 'EMPLOYEE',
      department: 'ENGINEERING',
      title: 'Mobile Developer',
      bio: 'Crafting beautiful mobile experiences with React Native and Flutter.',
      skills: ['React Native', 'Flutter', 'Swift', 'Kotlin', 'Firebase', 'TypeScript'],
      phone: '+1 (786) 555-0104',
      startDate: new Date('2023-06-01'),
      status: 'ACTIVE',
    },
  });

  const casey = await tx.user.upsert({
    where: {
      organizationId_email: {
        organizationId: 'org_devfathom',
        email: 'casey@company.com',
      },
    },
    update: { password },
    create: {
      name: 'Casey Brooks',
      email: 'casey@company.com',
      password,
      role: 'EMPLOYEE',
      department: 'PRODUCT',
      title: 'Product Owner & Researcher',
      bio: 'Bridging the gap between user needs and technical capabilities through research-driven product decisions.',
      skills: ['Product Management', 'User Research', 'Wireframing', 'Agile', 'Jira', 'Analytics'],
      phone: '+1 (786) 555-0105',
      startDate: new Date('2023-08-01'),
      status: 'ACTIVE',
    },
  });

  const riley = await tx.user.upsert({
    where: {
      organizationId_email: {
        organizationId: 'org_devfathom',
        email: 'riley@company.com',
      },
    },
    update: { password },
    create: {
      name: 'Riley Quinn',
      email: 'riley@company.com',
      password,
      role: 'EMPLOYEE',
      department: 'QUALITY',
      title: 'QA & Business Analyst',
      bio: 'Ensuring quality at every level — from requirements to deployment.',
      skills: ['Manual Testing', 'Automation', 'Selenium', 'Cypress', 'Business Analysis', 'SQL'],
      phone: '+1 (786) 555-0106',
      startDate: new Date('2023-09-01'),
      status: 'ACTIVE',
    },
  });

  const jamie = await tx.user.upsert({
    where: {
      organizationId_email: {
        organizationId: 'org_devfathom',
        email: 'jamie@company.com',
      },
    },
    update: { password },
    create: {
      name: 'Jamie Fox',
      email: 'jamie@company.com',
      password,
      role: 'EMPLOYEE',
      department: 'MARKETING',
      title: 'Marketing Manager',
      bio: 'Growing the brand presence through strategic digital marketing and content.',
      skills: ['SEO', 'Content Strategy', 'Social Media', 'Google Ads', 'Analytics', 'Copywriting'],
      phone: '+1 (786) 555-0107',
      startDate: new Date('2024-01-15'),
      status: 'ACTIVE',
    },
  });

  const morgan = await tx.user.upsert({
    where: {
      organizationId_email: {
        organizationId: 'org_devfathom',
        email: 'morgan@company.com',
      },
    },
    update: { password },
    create: {
      name: 'Morgan Hayes',
      email: 'morgan@company.com',
      password,
      role: 'EMPLOYEE',
      department: 'DESIGN',
      title: 'Designer',
      bio: 'Creating pixel-perfect designs that delight users and drive business outcomes.',
      skills: [
        'Figma',
        'UI/UX Design',
        'Design Systems',
        'Prototyping',
        'Illustration',
        'Motion Design',
      ],
      phone: '+1 (786) 555-0108',
      startDate: new Date('2024-02-01'),
      status: 'ACTIVE',
    },
  });

  const users = [alex, jordan, sam, taylor, casey, riley, jamie, morgan];
  console.log(`  ✓ Created ${users.length} team members\n`);

  // ============================================
  // CLIENTS — 4 client companies
  // ============================================
  console.log('🏢 Creating clients...');

  const northwind = await tx.client.create({
    data: {
      name: 'Northwind Logistics',
      website: 'https://northwind.example.com',
      industry: 'Logistics & Delivery',
      location: 'United States',
      timezone: 'America/New_York',
      status: 'ACTIVE',
      notes:
        'Long-term client. Delivery logistics platform with real-time tracking and route optimization.',
      contacts: {
        create: [
          {
            name: 'Jordan Blake',
            email: 'jordan.blake@northwind.example.com',
            phone: '+1 (305) 555-0201',
            role: 'CTO',
            isPrimary: true,
          },
          {
            name: 'Morgan Ellis',
            email: 'morgan.ellis@northwind.example.com',
            phone: '+1 (305) 555-0202',
            role: 'Product Manager',
          },
        ],
      },
    },
  });

  const meridian = await tx.client.create({
    data: {
      name: 'Meridian Finance',
      website: 'https://meridian.example.com',
      industry: 'Fintech',
      location: 'United States',
      timezone: 'America/New_York',
      status: 'ACTIVE',
      notes:
        'Fintech platform focused on decentralized finance solutions. High security requirements.',
      contacts: {
        create: [
          {
            name: 'Sam Rivera',
            email: 'sam.rivera@meridian.example.com',
            phone: '+1 (212) 555-0301',
            role: 'CEO',
            isPrimary: true,
          },
          {
            name: 'Casey Nguyen',
            email: 'casey.nguyen@meridian.example.com',
            phone: '+1 (212) 555-0302',
            role: 'Engineering Lead',
          },
        ],
      },
    },
  });

  const bluepeak = await tx.client.create({
    data: {
      name: 'Bluepeak',
      website: 'https://bluepeak.example.com',
      industry: 'Mobile Services',
      location: 'United States',
      timezone: 'America/Chicago',
      status: 'ACTIVE',
      notes: 'App-based service platform. Mobile-first approach with iOS and Android apps.',
      contacts: {
        create: [
          {
            name: 'Riley Adams',
            email: 'riley.adams@bluepeak.example.com',
            phone: '+1 (415) 555-0401',
            role: 'Founder',
            isPrimary: true,
          },
        ],
      },
    },
  });

  const hearthly = await tx.client.create({
    data: {
      name: 'Hearthly',
      website: 'https://hearthly.example.com',
      industry: 'Community & Social',
      location: 'United States',
      timezone: 'America/Los_Angeles',
      status: 'ACTIVE',
      notes:
        'Community platform with web and mobile apps. Focus on user engagement and content moderation.',
      contacts: {
        create: [
          {
            name: 'Taylor Brooks',
            email: 'taylor.brooks@hearthly.example.com',
            phone: '+1 (310) 555-0501',
            role: 'CEO',
            isPrimary: true,
          },
          {
            name: 'Casey Nguyen',
            email: 'casey.nguyen@hearthly.example.com',
            phone: '+1 (310) 555-0502',
            role: 'CTO',
          },
        ],
      },
    },
  });

  console.log('  ✓ Created 4 clients with contacts\n');

  // ============================================
  // PROJECTS — 4 client + 4 internal
  // ============================================
  console.log('📁 Creating projects...');

  const projectNorthwind = await tx.project.create({
    data: {
      name: 'Northwind Delivery Platform',
      description:
        'Full-stack delivery logistics platform with real-time tracking, route optimization, driver management, and customer-facing order tracking portal.',
      status: 'ACTIVE',
      type: 'CLIENT',
      startDate: new Date('2024-06-01'),
      endDate: new Date('2026-06-30'),
      techStack: [
        'Next.js',
        'React Native',
        'Node.js',
        'PostgreSQL',
        'Redis',
        'Google Maps API',
        'AWS',
      ],
      budget: 85000,
      clientId: northwind.id,
      members: {
        create: [
          { userId: alex.id, role: 'LEAD' },
          { userId: sam.id, role: 'MEMBER' },
          { userId: taylor.id, role: 'MEMBER' },
          { userId: morgan.id, role: 'MEMBER' },
        ],
      },
      milestones: {
        create: [
          {
            name: 'MVP Launch',
            description: 'Core delivery tracking features live',
            dueDate: new Date('2025-01-15'),
            completedAt: new Date('2025-01-20'),
          },
          {
            name: 'Mobile App Release',
            description: 'Driver and customer mobile apps',
            dueDate: new Date('2025-06-01'),
            completedAt: new Date('2025-05-28'),
          },
          {
            name: 'Route Optimization v2',
            description: 'AI-powered route optimization engine',
            dueDate: new Date('2026-03-15'),
          },
          {
            name: 'Analytics Dashboard',
            description: 'Business intelligence and reporting',
            dueDate: new Date('2026-05-30'),
          },
        ],
      },
    },
  });

  const projectMeridian = await tx.project.create({
    data: {
      name: 'Meridian Finance Platform',
      description:
        'Decentralized finance platform with crypto wallet integration, portfolio tracking, and automated trading strategies.',
      status: 'ACTIVE',
      type: 'CLIENT',
      startDate: new Date('2025-01-10'),
      endDate: new Date('2026-09-30'),
      techStack: ['Next.js', 'TypeScript', 'Solidity', 'Ethers.js', 'PostgreSQL', 'Redis', 'AWS'],
      budget: 120000,
      clientId: meridian.id,
      members: {
        create: [
          { userId: sam.id, role: 'LEAD' },
          { userId: alex.id, role: 'MEMBER' },
          { userId: riley.id, role: 'MEMBER' },
        ],
      },
      milestones: {
        create: [
          {
            name: 'Smart Contract Audit',
            description: 'Third-party security audit of all contracts',
            dueDate: new Date('2025-12-01'),
            completedAt: new Date('2025-11-28'),
          },
          {
            name: 'Beta Launch',
            description: 'Invite-only beta with test tokens',
            dueDate: new Date('2026-03-01'),
          },
          {
            name: 'Public Launch',
            description: 'Full public release',
            dueDate: new Date('2026-07-01'),
          },
        ],
      },
    },
  });

  const projectBluepeak = await tx.project.create({
    data: {
      name: 'Bluepeak App',
      description:
        'Mobile-first service platform with booking, payments, and real-time service tracking.',
      status: 'ACTIVE',
      type: 'CLIENT',
      startDate: new Date('2025-03-01'),
      endDate: new Date('2026-08-31'),
      techStack: ['React Native', 'Node.js', 'PostgreSQL', 'Stripe', 'Firebase', 'AWS'],
      budget: 65000,
      clientId: bluepeak.id,
      members: {
        create: [
          { userId: taylor.id, role: 'LEAD' },
          { userId: casey.id, role: 'MEMBER' },
          { userId: morgan.id, role: 'MEMBER' },
        ],
      },
      milestones: {
        create: [
          {
            name: 'Design System Complete',
            description: 'Full UI component library',
            dueDate: new Date('2025-06-15'),
            completedAt: new Date('2025-06-10'),
          },
          {
            name: 'iOS App Store Launch',
            description: 'First App Store release',
            dueDate: new Date('2026-04-15'),
          },
          {
            name: 'Android Launch',
            description: 'Google Play release',
            dueDate: new Date('2026-06-01'),
          },
        ],
      },
    },
  });

  const projectHearthly = await tx.project.create({
    data: {
      name: 'Hearthly Platform',
      description:
        'Community platform with web and mobile apps. User profiles, content feeds, groups, events, and moderation tools.',
      status: 'ACTIVE',
      type: 'CLIENT',
      startDate: new Date('2024-09-01'),
      endDate: new Date('2026-12-31'),
      techStack: [
        'Next.js',
        'React Native',
        'Node.js',
        'PostgreSQL',
        'Elasticsearch',
        'AWS',
        'CloudFront',
      ],
      budget: 95000,
      clientId: hearthly.id,
      members: {
        create: [
          { userId: alex.id, role: 'LEAD' },
          { userId: sam.id, role: 'MEMBER' },
          { userId: taylor.id, role: 'MEMBER' },
          { userId: casey.id, role: 'MEMBER' },
          { userId: morgan.id, role: 'MEMBER' },
        ],
      },
      milestones: {
        create: [
          {
            name: 'Web App Launch',
            description: 'Core community features on web',
            dueDate: new Date('2025-04-01'),
            completedAt: new Date('2025-04-05'),
          },
          {
            name: 'Mobile Apps v1',
            description: 'iOS and Android community apps',
            dueDate: new Date('2025-11-01'),
            completedAt: new Date('2025-10-29'),
          },
          {
            name: 'Events & Groups',
            description: 'Community events and groups feature',
            dueDate: new Date('2026-04-30'),
          },
          {
            name: 'Monetization Features',
            description: 'Premium memberships and marketplace',
            dueDate: new Date('2026-10-15'),
          },
        ],
      },
    },
  });

  // Internal projects
  const projectTravelDesk = await tx.project.create({
    data: {
      name: 'TravelDesk',
      description: 'Travel consultation and processing platform. Live and serving customers.',
      status: 'ACTIVE',
      type: 'INTERNAL',
      startDate: new Date('2024-03-01'),
      techStack: ['Next.js', 'Node.js', 'PostgreSQL', 'Stripe', 'Vercel'],
      members: {
        create: [
          { userId: alex.id, role: 'LEAD' },
          { userId: jamie.id, role: 'MEMBER' },
        ],
      },
    },
  });

  const projectMindmap = await tx.project.create({
    data: {
      name: 'MindMap',
      description:
        'AI-powered mind mapping and brainstorming tool. Internal product in development.',
      status: 'IN_DEVELOPMENT',
      type: 'INTERNAL',
      startDate: new Date('2025-09-01'),
      techStack: ['Next.js', 'TypeScript', 'Canvas API', 'OpenAI', 'PostgreSQL'],
      members: {
        create: [
          { userId: sam.id, role: 'LEAD' },
          { userId: morgan.id, role: 'MEMBER' },
        ],
      },
    },
  });

  const projectScopeFlow = await tx.project.create({
    data: {
      name: 'ScopeFlow',
      description:
        'B2B SaaS for scope management. Helps agencies define, track, and manage project scopes with clients.',
      status: 'IN_DEVELOPMENT',
      type: 'INTERNAL',
      startDate: new Date('2025-11-01'),
      techStack: ['Next.js', 'tRPC', 'Prisma', 'PostgreSQL', 'Stripe', 'Resend'],
      members: {
        create: [
          { userId: alex.id, role: 'LEAD' },
          { userId: casey.id, role: 'MEMBER' },
          { userId: sam.id, role: 'MEMBER' },
        ],
      },
    },
  });

  const projectWellMind = await tx.project.create({
    data: {
      name: 'WellMind',
      description:
        'Mental health and cognitive wellness app. Guided exercises, mood tracking, and AI-powered insights.',
      status: 'IN_DEVELOPMENT',
      type: 'INTERNAL',
      startDate: new Date('2026-01-15'),
      techStack: ['React Native', 'Node.js', 'PostgreSQL', 'TensorFlow', 'Firebase'],
      members: {
        create: [
          { userId: taylor.id, role: 'LEAD' },
          { userId: morgan.id, role: 'MEMBER' },
          { userId: casey.id, role: 'MEMBER' },
        ],
      },
    },
  });

  const allProjects = [
    projectNorthwind,
    projectMeridian,
    projectBluepeak,
    projectHearthly,
    projectTravelDesk,
    projectMindmap,
    projectScopeFlow,
    projectWellMind,
  ];
  console.log(`  ✓ Created ${allProjects.length} projects with milestones\n`);

  // ============================================
  // KANBAN BOARDS with columns and tasks
  // ============================================
  console.log('📋 Creating Kanban boards with tasks...');

  const defaultColumns = ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'];

  for (const project of allProjects) {
    const board = await tx.board.create({
      data: {
        name: `${project.name} Board`,
        description: `Main Kanban board for ${project.name}`,
        projectId: project.id,
        labels: {
          create: [
            { name: 'Bug', color: '#EF4444' },
            { name: 'Feature', color: '#4F46E5' },
            { name: 'Enhancement', color: '#06B6D4' },
            { name: 'Documentation', color: '#10B981' },
            { name: 'Design', color: '#F59E0B' },
            { name: 'Urgent', color: '#DC2626' },
          ],
        },
        columns: {
          create: defaultColumns.map((name, index) => ({
            name,
            order: index,
          })),
        },
      },
      include: { columns: true, labels: true },
    });

    // Create sample tasks for first 4 projects (client projects)
    if (
      [projectNorthwind.id, projectMeridian.id, projectBluepeak.id, projectHearthly.id].includes(
        project.id
      )
    ) {
      const columns = board.columns.sort((a, b) => a.order - b.order);
      const labels = board.labels;
      const featureLabel = labels.find((l) => l.name === 'Feature');
      const bugLabel = labels.find((l) => l.name === 'Bug');
      const enhLabel = labels.find((l) => l.name === 'Enhancement');

      const taskData = getTasksForProject(project.name);

      for (const task of taskData) {
        const column = columns[task.columnIndex];
        const label =
          task.labelType === 'feature'
            ? featureLabel
            : task.labelType === 'bug'
              ? bugLabel
              : enhLabel;

        const createdTask = await tx.task.create({
          data: {
            title: task.title,
            description: task.description,
            columnId: column.id,
            order: task.order,
            priority: task.priority as 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT',
            dueDate: task.dueDate ? new Date(task.dueDate) : null,
            createdById: alex.id,
            assignees: {
              create: task.assigneeIds.map((id: string) => ({ userId: id })),
            },
            labels: label ? { create: [{ labelId: label.id }] } : undefined,
          },
        });

        // Add checklists to some tasks
        if (task.checklist) {
          await tx.taskChecklist.create({
            data: {
              name: task.checklist.name,
              taskId: createdTask.id,
              items: {
                create: task.checklist.items.map(
                  (item: { text: string; completed: boolean }, idx: number) => ({
                    text: item.text,
                    completed: item.completed,
                    order: idx,
                  })
                ),
              },
            },
          });
        }
      }
    }
  }

  // Assign tasks to project members so "My Tasks" works
  const allTasks = await tx.task.findMany({
    include: { column: { include: { board: true } } },
  });

  for (let i = 0; i < allTasks.length; i++) {
    const task = allTasks[i];
    const projectId = task.column.board.projectId;
    const members = await tx.projectMember.findMany({
      where: { projectId },
      select: { userId: true },
    });
    if (members.length > 0) {
      const memberIdx = i % members.length;
      const existing = await tx.taskAssignee.findFirst({ where: { taskId: task.id } });
      if (!existing) {
        await tx.taskAssignee.create({
          data: { taskId: task.id, userId: members[memberIdx].userId },
        });
      }
    }
  }

  console.log('  ✓ Created boards with columns, labels, and tasks\n');

  // ============================================
  // FINANCE — Sample invoices and transactions
  // ============================================
  console.log('💰 Creating financial data...');

  // Invoices
  const invoices = [
    {
      number: 'INV-2025-001',
      client: northwind,
      project: projectNorthwind,
      total: 15000,
      status: 'PAID' as const,
      date: '2025-01-15',
      paidDate: '2025-01-28',
    },
    {
      number: 'INV-2025-002',
      client: northwind,
      project: projectNorthwind,
      total: 15000,
      status: 'PAID' as const,
      date: '2025-04-15',
      paidDate: '2025-04-22',
    },
    {
      number: 'INV-2025-003',
      client: meridian,
      project: projectMeridian,
      total: 20000,
      status: 'PAID' as const,
      date: '2025-03-01',
      paidDate: '2025-03-15',
    },
    {
      number: 'INV-2025-004',
      client: meridian,
      project: projectMeridian,
      total: 20000,
      status: 'PAID' as const,
      date: '2025-06-01',
      paidDate: '2025-06-10',
    },
    {
      number: 'INV-2025-005',
      client: bluepeak,
      project: projectBluepeak,
      total: 12000,
      status: 'PAID' as const,
      date: '2025-05-01',
      paidDate: '2025-05-15',
    },
    {
      number: 'INV-2025-006',
      client: hearthly,
      project: projectHearthly,
      total: 18000,
      status: 'PAID' as const,
      date: '2025-07-01',
      paidDate: '2025-07-12',
    },
    {
      number: 'INV-2025-007',
      client: northwind,
      project: projectNorthwind,
      total: 15000,
      status: 'PAID' as const,
      date: '2025-08-01',
      paidDate: '2025-08-10',
    },
    {
      number: 'INV-2025-008',
      client: hearthly,
      project: projectHearthly,
      total: 18000,
      status: 'PAID' as const,
      date: '2025-10-01',
      paidDate: '2025-10-08',
    },
    {
      number: 'INV-2026-001',
      client: meridian,
      project: projectMeridian,
      total: 25000,
      status: 'PAID' as const,
      date: '2026-01-15',
      paidDate: '2026-01-25',
    },
    {
      number: 'INV-2026-002',
      client: northwind,
      project: projectNorthwind,
      total: 15000,
      status: 'PAID' as const,
      date: '2026-02-01',
      paidDate: '2026-02-14',
    },
    {
      number: 'INV-2026-003',
      client: bluepeak,
      project: projectBluepeak,
      total: 14000,
      status: 'SENT' as const,
      date: '2026-03-15',
      paidDate: null,
    },
    {
      number: 'INV-2026-004',
      client: hearthly,
      project: projectHearthly,
      total: 20000,
      status: 'OVERDUE' as const,
      date: '2026-03-01',
      paidDate: null,
    },
    {
      number: 'INV-2026-005',
      client: meridian,
      project: projectMeridian,
      total: 25000,
      status: 'DRAFT' as const,
      date: '2026-04-01',
      paidDate: null,
    },
  ];

  for (const inv of invoices) {
    await tx.invoice.create({
      data: {
        invoiceNumber: inv.number,
        clientId: inv.client.id,
        projectId: inv.project.id,
        items: [
          {
            description: 'Development Services',
            quantity: 1,
            rate: inv.total * 0.7,
            amount: inv.total * 0.7,
          },
          {
            description: 'Design & UX',
            quantity: 1,
            rate: inv.total * 0.2,
            amount: inv.total * 0.2,
          },
          {
            description: 'Project Management',
            quantity: 1,
            rate: inv.total * 0.1,
            amount: inv.total * 0.1,
          },
        ],
        subtotal: inv.total,
        tax: 0,
        total: inv.total,
        currency: 'USD',
        status: inv.status,
        dueDate: new Date(new Date(inv.date).getTime() + 30 * 24 * 60 * 60 * 1000),
        paidAt: inv.paidDate ? new Date(inv.paidDate) : null,
        sentAt: inv.status !== 'DRAFT' ? new Date(inv.date) : null,
      },
    });
  }

  // Direct seed inserts must advance the same allocator used by application
  // creates, otherwise the first real invoice could reuse a seeded number.
  for (const [year, lastNumber] of [
    [2025, 8],
    [2026, 5],
  ] as const) {
    await tx.invoiceNumberSequence.upsert({
      where: { organizationId_year: { organizationId: 'org_devfathom', year } },
      create: { organizationId: 'org_devfathom', year, lastNumber },
      update: { lastNumber: { set: lastNumber } },
    });
  }

  // Transactions — Income from paid invoices
  const incomeTransactions = invoices
    .filter((inv) => inv.status === 'PAID')
    .map((inv) => ({
      type: 'INCOME' as const,
      amount: inv.total,
      currency: 'USD' as const,
      description: `Payment for ${inv.number}`,
      projectId: inv.project.id,
      clientId: inv.client.id,
      date: new Date(inv.paidDate!),
    }));

  // Expense transactions
  const expenses = [
    {
      amount: 8500,
      category: 'SALARIES' as const,
      desc: 'Monthly Salaries - January 2026',
      date: '2026-01-31',
    },
    {
      amount: 8500,
      category: 'SALARIES' as const,
      desc: 'Monthly Salaries - February 2026',
      date: '2026-02-28',
    },
    {
      amount: 8500,
      category: 'SALARIES' as const,
      desc: 'Monthly Salaries - March 2026',
      date: '2026-03-31',
    },
    {
      amount: 299,
      category: 'SUBSCRIPTIONS' as const,
      desc: 'AWS Monthly - January',
      date: '2026-01-05',
    },
    {
      amount: 299,
      category: 'SUBSCRIPTIONS' as const,
      desc: 'AWS Monthly - February',
      date: '2026-02-05',
    },
    {
      amount: 299,
      category: 'SUBSCRIPTIONS' as const,
      desc: 'AWS Monthly - March',
      date: '2026-03-05',
    },
    {
      amount: 20,
      category: 'SUBSCRIPTIONS' as const,
      desc: 'Vercel Pro - January',
      date: '2026-01-01',
    },
    {
      amount: 20,
      category: 'SUBSCRIPTIONS' as const,
      desc: 'Vercel Pro - February',
      date: '2026-02-01',
    },
    {
      amount: 20,
      category: 'SUBSCRIPTIONS' as const,
      desc: 'Vercel Pro - March',
      date: '2026-03-01',
    },
    {
      amount: 45,
      category: 'SUBSCRIPTIONS' as const,
      desc: 'Figma Team - Monthly',
      date: '2026-01-15',
    },
    {
      amount: 45,
      category: 'SUBSCRIPTIONS' as const,
      desc: 'Figma Team - Monthly',
      date: '2026-02-15',
    },
    {
      amount: 150,
      category: 'MARKETING' as const,
      desc: 'Google Ads - January Campaign',
      date: '2026-01-20',
    },
    {
      amount: 200,
      category: 'MARKETING' as const,
      desc: 'Google Ads - February Campaign',
      date: '2026-02-20',
    },
    {
      amount: 250,
      category: 'MARKETING' as const,
      desc: 'Google Ads - March Campaign',
      date: '2026-03-20',
    },
    { amount: 89, category: 'SOFTWARE' as const, desc: 'GitHub Team Plan', date: '2026-01-10' },
    {
      amount: 500,
      category: 'OFFICE' as const,
      desc: 'Office Supplies & Equipment',
      date: '2026-02-10',
    },
    { amount: 120, category: 'HOSTING' as const, desc: 'Domain Renewals', date: '2026-01-25' },
  ];

  for (const t of incomeTransactions) {
    await tx.transaction.create({ data: t });
  }

  for (const exp of expenses) {
    await tx.transaction.create({
      data: {
        type: 'EXPENSE',
        amount: exp.amount,
        currency: 'USD',
        category: exp.category,
        description: exp.desc,
        date: new Date(exp.date),
      },
    });
  }

  // Recurring expenses
  await tx.recurringExpense.createMany({
    data: [
      {
        name: 'AWS Cloud Services',
        amount: 299,
        currency: 'USD',
        category: 'HOSTING',
        interval: 'monthly',
        nextDueDate: new Date('2026-05-05'),
        vendorName: 'Amazon Web Services',
      },
      {
        name: 'Vercel Pro',
        amount: 20,
        currency: 'USD',
        category: 'HOSTING',
        interval: 'monthly',
        nextDueDate: new Date('2026-05-01'),
        vendorName: 'Vercel',
      },
      {
        name: 'Figma Team',
        amount: 45,
        currency: 'USD',
        category: 'SOFTWARE',
        interval: 'monthly',
        nextDueDate: new Date('2026-05-15'),
        vendorName: 'Figma',
      },
      {
        name: 'GitHub Team',
        amount: 89,
        currency: 'USD',
        category: 'SOFTWARE',
        interval: 'monthly',
        nextDueDate: new Date('2026-05-10'),
        vendorName: 'GitHub',
      },
      {
        name: 'Google Workspace',
        amount: 72,
        currency: 'USD',
        category: 'SOFTWARE',
        interval: 'monthly',
        nextDueDate: new Date('2026-05-01'),
        vendorName: 'Google',
      },
      {
        name: 'Slack Business+',
        amount: 63,
        currency: 'USD',
        category: 'SOFTWARE',
        interval: 'monthly',
        nextDueDate: new Date('2026-05-01'),
        vendorName: 'Slack',
      },
    ],
  });

  console.log('  ✓ Created invoices, transactions, and recurring expenses\n');

  // ============================================
  // CHAT — Default channels
  // ============================================
  console.log('💬 Creating chat channels...');

  const generalChannel = await tx.channel.create({
    data: {
      name: 'general',
      description: 'General team discussions and announcements',
      type: 'GROUP',
      members: {
        create: users.map((u) => ({ userId: u.id })),
      },
    },
  });

  const devChannel = await tx.channel.create({
    data: {
      name: 'dev-team',
      description: 'Engineering discussions, code reviews, and technical decisions',
      type: 'GROUP',
      members: {
        create: [alex, sam, taylor].map((u) => ({ userId: u.id })),
      },
    },
  });

  const announcementsChannel = await tx.channel.create({
    data: {
      name: 'announcements',
      description: 'Company-wide announcements (admin only posts)',
      type: 'GROUP',
      members: {
        create: users.map((u) => ({ userId: u.id })),
      },
    },
  });

  // Project channels
  for (const project of [projectNorthwind, projectMeridian, projectBluepeak, projectHearthly]) {
    const members = await tx.projectMember.findMany({ where: { projectId: project.id } });
    await tx.channel.create({
      data: {
        name: project.name.toLowerCase().replace(/\s+/g, '-'),
        description: `Discussion channel for ${project.name}`,
        type: 'PROJECT',
        members: {
          create: members.map((m) => ({ userId: m.userId })),
        },
      },
    });
  }

  // Sample messages in general channel
  const welcomeMessages = [
    {
      content: "Welcome to DevFathom! 🚀 This is our new internal platform. Let's make it great.",
      senderId: alex.id,
    },
    {
      content: 'Looks amazing! Much better than juggling between different tools.',
      senderId: sam.id,
    },
    { content: 'The dashboard is really clean. Great work on the design! 🎨', senderId: morgan.id },
    {
      content: "Can't wait to migrate our Trello boards over. When is that feature ready?",
      senderId: casey.id,
    },
    {
      content: 'Trello import is almost ready. We should be able to migrate all boards this week.',
      senderId: alex.id,
    },
  ];

  for (let i = 0; i < welcomeMessages.length; i++) {
    await tx.message.create({
      data: {
        content: welcomeMessages[i].content,
        channelId: generalChannel.id,
        senderId: welcomeMessages[i].senderId,
        createdAt: new Date(Date.now() - (welcomeMessages.length - i) * 3600000),
      },
    });
  }

  console.log('  ✓ Created channels and sample messages\n');

  // ============================================
  // LEAVE REQUESTS — Sample data
  // ============================================
  console.log('📅 Creating leave requests...');

  await tx.leaveRequest.createMany({
    data: [
      {
        userId: sam.id,
        type: 'VACATION',
        startDate: new Date('2026-05-01'),
        endDate: new Date('2026-05-05'),
        status: 'APPROVED',
        approvedById: alex.id,
        reason: 'Family vacation',
      },
      {
        userId: taylor.id,
        type: 'SICK',
        startDate: new Date('2026-03-20'),
        endDate: new Date('2026-03-21'),
        status: 'APPROVED',
        approvedById: alex.id,
        reason: 'Not feeling well',
      },
      {
        userId: jamie.id,
        type: 'REMOTE',
        startDate: new Date('2026-04-14'),
        endDate: new Date('2026-04-18'),
        status: 'PENDING',
        reason: 'Working from home — family visiting',
      },
      {
        userId: casey.id,
        type: 'VACATION',
        startDate: new Date('2026-06-15'),
        endDate: new Date('2026-06-20'),
        status: 'PENDING',
        reason: 'Personal travel',
      },
      {
        userId: riley.id,
        type: 'SICK',
        startDate: new Date('2026-04-08'),
        endDate: new Date('2026-04-09'),
        status: 'APPROVED',
        approvedById: jordan.id,
        reason: 'Doctor appointment',
      },
    ],
  });

  console.log('  ✓ Created leave requests\n');

  // ============================================
  // ACTIVITY LOG — Recent activity
  // ============================================
  console.log('📊 Creating activity feed...');

  const activities = [
    {
      type: 'project_updated',
      message: 'Updated Northwind Delivery milestone to completed',
      userId: alex.id,
      entityType: 'Project',
      entityId: projectNorthwind.id,
    },
    {
      type: 'task_created',
      message: 'Created task "Implement real-time order tracking"',
      userId: sam.id,
      entityType: 'Task',
    },
    {
      type: 'invoice_sent',
      message: 'Sent invoice INV-2026-003 to Bluepeak ($14,000)',
      userId: jordan.id,
      entityType: 'Invoice',
    },
    {
      type: 'member_joined',
      message: 'Jamie joined the Marketing Manager role',
      userId: jamie.id,
      entityType: 'User',
      entityId: jamie.id,
    },
    {
      type: 'task_completed',
      message: 'Completed "Design system documentation"',
      userId: morgan.id,
      entityType: 'Task',
    },
    {
      type: 'project_created',
      message: 'Created new project: WellMind',
      userId: alex.id,
      entityType: 'Project',
      entityId: projectWellMind.id,
    },
    {
      type: 'comment_added',
      message: 'Commented on "API integration for payment gateway"',
      userId: riley.id,
      entityType: 'Task',
    },
    {
      type: 'invoice_paid',
      message: 'Invoice INV-2026-002 marked as paid ($15,000)',
      userId: jordan.id,
      entityType: 'Invoice',
    },
    {
      type: 'leave_requested',
      message: 'Jamie requested remote work for Apr 14-18',
      userId: jamie.id,
      entityType: 'LeaveRequest',
    },
    {
      type: 'task_assigned',
      message: 'Assigned "Mobile app performance optimization" to Taylor',
      userId: casey.id,
      entityType: 'Task',
    },
  ];

  for (let i = 0; i < activities.length; i++) {
    await tx.activity.create({
      data: {
        ...activities[i],
        createdAt: new Date(Date.now() - i * 7200000), // 2 hours apart
      },
    });
  }

  console.log('  ✓ Created activity feed\n');

  // ============================================
  // NOTIFICATIONS — Unread notifications
  // ============================================
  console.log('🔔 Creating notifications...');

  await tx.notification.createMany({
    data: [
      {
        userId: alex.id,
        title: 'Invoice Overdue',
        message: 'Invoice INV-2026-004 for Hearthly is overdue',
        type: 'invoice_overdue',
        isRead: false,
      },
      {
        userId: alex.id,
        title: 'Leave Request',
        message: 'Jamie has requested remote work for Apr 14-18',
        type: 'leave_request',
        isRead: false,
      },
      {
        userId: alex.id,
        title: 'Milestone Approaching',
        message: 'Route Optimization v2 milestone is due in 5 days',
        type: 'milestone_due',
        isRead: false,
      },
      {
        userId: sam.id,
        title: 'New Task Assigned',
        message: 'You\'ve been assigned "Implement WebSocket connection pooling"',
        type: 'task_assigned',
        isRead: false,
      },
      {
        userId: sam.id,
        title: 'Code Review Request',
        message: 'Taylor requested a code review on PR #147',
        type: 'review_request',
        isRead: true,
      },
      {
        userId: taylor.id,
        title: 'Task Due Tomorrow',
        message: '"Push notification integration" is due tomorrow',
        type: 'task_due',
        isRead: false,
      },
      {
        userId: casey.id,
        title: 'Comment Mention',
        message: 'Alex mentioned you in a comment on "User research findings"',
        type: 'mention',
        isRead: false,
      },
      {
        userId: jordan.id,
        title: 'Payment Received',
        message: 'Northwind Logistics paid invoice INV-2026-002 ($15,000)',
        type: 'invoice_paid',
        isRead: true,
      },
    ],
  });

  console.log('  ✓ Created notifications\n');

  // ============================================
  // MEETINGS — Upcoming meetings
  // ============================================
  console.log('📅 Creating meetings...');

  const now = new Date();

  const meetingsData = [
    {
      title: 'Sprint Planning',
      description: 'Plan the next two-week sprint. Review backlog and assign priorities.',
      startTime: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 10, 0),
      endTime: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 11, 0),
      location: 'Google Meet',
      createdById: alex.id,
      attendeeIds: [alex.id, sam.id, taylor.id, casey.id, riley.id],
    },
    {
      title: 'Design Review',
      description: 'Review Hearthly mobile app redesign mockups.',
      startTime: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 14, 0),
      endTime: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 15, 0),
      location: 'Figma',
      createdById: morgan.id,
      attendeeIds: [morgan.id, alex.id, casey.id],
    },
    {
      title: 'Client Sync — Northwind Logistics',
      description: 'Weekly check-in with Northwind Logistics team on progress and blockers.',
      startTime: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 16, 0),
      endTime: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 16, 30),
      location: 'Zoom',
      createdById: jordan.id,
      attendeeIds: [jordan.id, alex.id, sam.id],
    },
    {
      title: 'Team Standup',
      description: "Daily standup — what you did, what you're doing, blockers.",
      startTime: new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 3, 0),
      endTime: new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 3, 15),
      location: 'Google Meet',
      createdById: alex.id,
      attendeeIds: users.map((u) => u.id),
    },
    {
      title: 'Meridian Finance Security Audit Review',
      description: 'Go through the audit findings and prioritize fixes.',
      startTime: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3, 11, 0),
      endTime: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3, 12, 0),
      location: 'Office',
      createdById: sam.id,
      attendeeIds: [sam.id, alex.id, riley.id],
    },
  ];

  for (const m of meetingsData) {
    const { attendeeIds, ...meetingData } = m;
    await tx.meeting.create({
      data: {
        ...meetingData,
        attendees: { create: attendeeIds.map((userId) => ({ userId })) },
      },
    });
  }

  console.log('  ✓ Created meetings\n');

  console.log('✅ Seeding complete! DevFathom is ready.\n');
  console.log('Login: [firstname]@company.com — password is the SEED_PASSWORD you provided.');
  console.log('\nAdmin accounts: alex@company.com, jordan@company.com');
}

async function main() {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.is_platform_admin', 'true', true),
                set_config('app.current_organization_id', 'org_devfathom', true)`
      );

      const suite = await tx.platformPackage.upsert({
        where: { key: 'agency-suite' },
        update: { active: true },
        create: {
          key: 'agency-suite',
          name: 'Agency Suite',
          description: 'Complete DevFathom agency operating system.',
          defaultSeats: 25,
        },
      });

      const organization = await tx.organization.upsert({
        where: { id: 'org_devfathom' },
        update: { packageId: suite.id },
        create: {
          id: 'org_devfathom',
          slug: 'devfathom',
          legalName: 'DevFathom',
          displayName: 'DevFathom',
          status: 'ACTIVE',
          packageId: suite.id,
          timezone: 'Asia/Karachi',
          seatLimit: 1000,
          gracePeriodDays: 14,
          activatedAt: new Date(),
        },
      });

      // WHA-290: `User.department` is a composite foreign key onto
      // `organization_departments`, so the demo team seeded below cannot exist
      // until this organization's catalog does. Taken from the vertical catalog
      // rather than restated here, exactly as bootstrapOrganization does.
      await tx.organizationDepartment.createMany({
        data: defaultDepartmentRowsForVertical(organization.vertical).map((department) => ({
          organizationId: organization.id,
          ...department,
        })),
        skipDuplicates: true,
      });

      // Reconciles the whole module and package registry — agency AND restaurant —
      // so a database that predates a shipped module still receives it. Runs
      // ahead of seedTenantData's early return, which is the path an existing
      // staging database takes on every redeploy.
      const { moduleIds } = await syncPlatformCatalog(tx);

      for (const [key] of AGENCY_SUITE_MODULES) {
        const moduleId = moduleIds.get(key);
        if (!moduleId) throw new Error(`Unknown platform module: ${key}`);
        await tx.platformPackageModule.upsert({
          where: { packageId_moduleId: { packageId: suite.id, moduleId } },
          update: { enabled: true },
          create: { packageId: suite.id, moduleId },
        });
        // §2.3: org_devfathom inherits its modules live from the Agency Suite
        // package (platform_package_modules); no OrganizationModule copy.
      }

      const adminRole = await tx.organizationRole.upsert({
        where: {
          organizationId_key: { organizationId: 'org_devfathom', key: 'admin' },
        },
        update: { name: 'Administrator', isSystem: true },
        create: {
          organizationId: 'org_devfathom',
          key: 'admin',
          name: 'Administrator',
          description: 'Full organization administration.',
          isSystem: true,
        },
      });
      const memberRole = await tx.organizationRole.upsert({
        where: {
          organizationId_key: { organizationId: 'org_devfathom', key: 'member' },
        },
        update: { name: 'Member', isSystem: true },
        create: {
          organizationId: 'org_devfathom',
          key: 'member',
          name: 'Member',
          description: 'Standard workspace member.',
          isSystem: true,
        },
      });
      await tx.organizationRolePermission.upsert({
        where: {
          organizationRoleId_capability: {
            organizationRoleId: adminRole.id,
            capability: '*',
          },
        },
        update: { effect: 'ALLOW' },
        create: {
          organizationId: 'org_devfathom',
          organizationRoleId: adminRole.id,
          capability: '*',
          effect: 'ALLOW',
        },
      });

      await tx.organizationBrand.upsert({
        where: { organizationId: 'org_devfathom' },
        update: {},
        create: { organizationId: 'org_devfathom' },
      });
      await tx.organizationDeployment.upsert({
        where: {
          organizationId_environment: {
            organizationId: 'org_devfathom',
            environment: 'production',
          },
        },
        update: { mode: 'SHARED' },
        create: {
          organizationId: 'org_devfathom',
          environment: 'production',
          mode: 'SHARED',
          status: 'READY',
          provider: 'VERCEL',
        },
      });

      // Runs ahead of seedTenantData because that function returns early once
      // seed data is present, refreshing the eight @company.com tenant users and
      // nothing else. A rotated PLATFORM_ADMIN_PASSWORD has to land on every
      // deployment, not only the one that creates the administrator.
      await upsertPlatformAdmin(tx);
      // The staging workspace administrator (ADMIN_EMAIL / ADMIN_PASSWORD) is
      // not one of the demo @company.com users. Create it on every deploy,
      // including the early return inside seedTenantData.
      await upsertStagingAdmin(tx, {
        organizationId: organization.id,
        organizationRoleId: adminRole.id,
      });

      await seedTenantData(tx);
      await tx.user.updateMany({
        where: { organizationId: 'org_devfathom', role: 'ADMIN' },
        data: { organizationRoleId: adminRole.id },
      });
      await tx.user.updateMany({
        where: { organizationId: 'org_devfathom', role: { not: 'ADMIN' } },
        data: { organizationRoleId: memberRole.id },
      });
    },
    { maxWait: 30_000, timeout: 300_000 }
  );
}

// ============================================
// HELPER: Generate realistic tasks per project
// ============================================
function getTasksForProject(projectName: string) {
  const tasks: Record<
    string,
    Array<{
      title: string;
      description: string;
      columnIndex: number;
      order: number;
      priority: string;
      dueDate: string | null;
      assigneeIds: string[];
      labelType: string;
      checklist?: { name: string; items: { text: string; completed: boolean }[] };
    }>
  > = {
    'Northwind Delivery Platform': [
      {
        title: 'Implement real-time GPS tracking',
        description:
          'Add WebSocket-based real-time driver location tracking on the customer order page.',
        columnIndex: 2,
        order: 0,
        priority: 'HIGH',
        dueDate: '2026-04-20',
        assigneeIds: [],
        labelType: 'feature',
        checklist: {
          name: 'Implementation Steps',
          items: [
            { text: 'Set up WebSocket server', completed: true },
            { text: 'Create GPS update handler', completed: true },
            { text: 'Build map component', completed: false },
            { text: 'Add driver location markers', completed: false },
          ],
        },
      },
      {
        title: 'Route optimization algorithm v2',
        description:
          'Improve the route optimization engine with ML-based predictions for traffic and delivery windows.',
        columnIndex: 1,
        order: 0,
        priority: 'HIGH',
        dueDate: '2026-05-15',
        assigneeIds: [],
        labelType: 'feature',
      },
      {
        title: 'Fix delivery status not updating',
        description:
          'Some drivers report that delivery status changes are not reflected on the customer side immediately.',
        columnIndex: 2,
        order: 1,
        priority: 'URGENT',
        dueDate: '2026-04-12',
        assigneeIds: [],
        labelType: 'bug',
      },
      {
        title: 'Analytics dashboard design',
        description:
          'Design the business analytics dashboard showing delivery metrics, driver performance, and revenue.',
        columnIndex: 3,
        order: 0,
        priority: 'MEDIUM',
        dueDate: '2026-04-25',
        assigneeIds: [],
        labelType: 'feature',
      },
      {
        title: 'Driver onboarding flow',
        description: 'Complete the self-service driver registration and onboarding process.',
        columnIndex: 4,
        order: 0,
        priority: 'MEDIUM',
        dueDate: null,
        assigneeIds: [],
        labelType: 'feature',
      },
      {
        title: 'Push notification system',
        description:
          'Implement push notifications for order updates, driver assignment, and delivery completion.',
        columnIndex: 0,
        order: 0,
        priority: 'MEDIUM',
        dueDate: '2026-05-01',
        assigneeIds: [],
        labelType: 'feature',
      },
      {
        title: 'Customer rating system',
        description: 'Allow customers to rate deliveries and drivers after completion.',
        columnIndex: 0,
        order: 1,
        priority: 'LOW',
        dueDate: null,
        assigneeIds: [],
        labelType: 'enhancement',
      },
    ],
    'Meridian Finance Platform': [
      {
        title: 'Implement portfolio rebalancing',
        description:
          'Build the automated portfolio rebalancing feature based on user-defined allocation targets.',
        columnIndex: 2,
        order: 0,
        priority: 'HIGH',
        dueDate: '2026-04-30',
        assigneeIds: [],
        labelType: 'feature',
      },
      {
        title: 'Security audit findings - XSS fix',
        description:
          'Address cross-site scripting vulnerability found in the portfolio name input field.',
        columnIndex: 2,
        order: 1,
        priority: 'URGENT',
        dueDate: '2026-04-11',
        assigneeIds: [],
        labelType: 'bug',
      },
      {
        title: 'Multi-chain wallet support',
        description: 'Extend wallet integration to support Ethereum, Polygon, and Arbitrum chains.',
        columnIndex: 1,
        order: 0,
        priority: 'HIGH',
        dueDate: '2026-05-20',
        assigneeIds: [],
        labelType: 'feature',
      },
      {
        title: 'Transaction history export',
        description:
          'Allow users to export their transaction history as CSV/PDF for tax reporting.',
        columnIndex: 3,
        order: 0,
        priority: 'MEDIUM',
        dueDate: '2026-04-18',
        assigneeIds: [],
        labelType: 'feature',
      },
      {
        title: 'Gas fee estimation widget',
        description:
          'Show estimated gas fees before transaction confirmation with real-time updates.',
        columnIndex: 4,
        order: 0,
        priority: 'LOW',
        dueDate: null,
        assigneeIds: [],
        labelType: 'enhancement',
      },
      {
        title: 'Beta launch landing page',
        description: 'Create the marketing landing page for the beta launch with waitlist signup.',
        columnIndex: 0,
        order: 0,
        priority: 'MEDIUM',
        dueDate: '2026-05-01',
        assigneeIds: [],
        labelType: 'feature',
      },
    ],
    'Bluepeak App': [
      {
        title: 'Booking flow redesign',
        description:
          'Redesign the booking flow to reduce steps from 5 to 3 for faster conversions.',
        columnIndex: 2,
        order: 0,
        priority: 'HIGH',
        dueDate: '2026-04-22',
        assigneeIds: [],
        labelType: 'enhancement',
      },
      {
        title: 'Payment gateway integration',
        description: 'Integrate Stripe for credit card payments and Apple Pay / Google Pay.',
        columnIndex: 1,
        order: 0,
        priority: 'HIGH',
        dueDate: '2026-05-01',
        assigneeIds: [],
        labelType: 'feature',
      },
      {
        title: 'Push notification system',
        description:
          'Set up Firebase Cloud Messaging for booking confirmations and service reminders.',
        columnIndex: 1,
        order: 1,
        priority: 'MEDIUM',
        dueDate: '2026-05-10',
        assigneeIds: [],
        labelType: 'feature',
      },
      {
        title: 'Service provider profiles',
        description:
          'Build detailed service provider profile pages with ratings, reviews, and availability.',
        columnIndex: 3,
        order: 0,
        priority: 'MEDIUM',
        dueDate: '2026-04-15',
        assigneeIds: [],
        labelType: 'feature',
      },
      {
        title: 'App performance optimization',
        description: 'Reduce app load time by 40% through image optimization and lazy loading.',
        columnIndex: 0,
        order: 0,
        priority: 'HIGH',
        dueDate: '2026-05-15',
        assigneeIds: [],
        labelType: 'enhancement',
      },
    ],
    'Hearthly Platform': [
      {
        title: 'Community events feature',
        description:
          'Build the events creation, RSVP, and event detail pages for community groups.',
        columnIndex: 2,
        order: 0,
        priority: 'HIGH',
        dueDate: '2026-04-28',
        assigneeIds: [],
        labelType: 'feature',
        checklist: {
          name: 'Event Features',
          items: [
            { text: 'Event creation form', completed: true },
            { text: 'RSVP system', completed: false },
            { text: 'Event detail page', completed: false },
            { text: 'Calendar integration', completed: false },
            { text: 'Email notifications', completed: false },
          ],
        },
      },
      {
        title: 'Content moderation dashboard',
        description:
          'Admin dashboard for reviewing and moderating user-generated content with AI-assisted flagging.',
        columnIndex: 1,
        order: 0,
        priority: 'HIGH',
        dueDate: '2026-05-15',
        assigneeIds: [],
        labelType: 'feature',
      },
      {
        title: 'Fix image upload on mobile',
        description: 'Images uploaded from iOS Safari sometimes fail due to HEIC format issues.',
        columnIndex: 2,
        order: 1,
        priority: 'URGENT',
        dueDate: '2026-04-12',
        assigneeIds: [],
        labelType: 'bug',
      },
      {
        title: 'User onboarding improvements',
        description:
          'Redesign the first-time user experience with guided tours and interest-based recommendations.',
        columnIndex: 3,
        order: 0,
        priority: 'MEDIUM',
        dueDate: '2026-04-20',
        assigneeIds: [],
        labelType: 'enhancement',
      },
      {
        title: 'Group chat feature',
        description: 'Enable real-time group messaging within community groups.',
        columnIndex: 0,
        order: 0,
        priority: 'MEDIUM',
        dueDate: '2026-06-01',
        assigneeIds: [],
        labelType: 'feature',
      },
      {
        title: 'SEO optimization',
        description:
          'Implement proper meta tags, structured data, and SSR for all public-facing pages.',
        columnIndex: 0,
        order: 1,
        priority: 'LOW',
        dueDate: null,
        assigneeIds: [],
        labelType: 'enhancement',
      },
    ],
  };

  return tasks[projectName] || [];
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
