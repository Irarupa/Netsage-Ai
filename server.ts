import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { dbService } from './server/db.js';
import { runAllRuleChecks } from './server/ruleChecker.js';
import { runAIDiagnosis, getPromptTemplate, savePromptTemplate } from './server/geminiService.js';
import { parsePktFileContent, diagnosePktTopology } from './server/pktAnalyzer.js';
import { NetworkCase, NetworkAlert } from './src/types.js';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ==================== API ROUTES ====================

  // 0. Auth & User Management
  app.get('/api/auth/users', (_req, res) => {
    try {
      const users = dbService.getAllUsers();
      res.json(users);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }
      const result = dbService.loginUser(email, password);
      res.json(result);
    } catch (err: any) {
      res.status(401).json({ error: err.message || 'Login failed' });
    }
  });

  app.post('/api/auth/register', (req, res) => {
    try {
      const { email, password, name, role, title, department } = req.body;
      if (!email || !name) {
        return res.status(400).json({ error: 'Email and Name are required' });
      }
      const result = dbService.registerUser({ email, password, name, role, title, department });
      res.status(201).json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Registration failed' });
    }
  });

  app.get('/api/auth/user/:id', (req, res) => {
    try {
      const user = dbService.getUserById(req.params.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json(user);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/auth/user/:id', (req, res) => {
    try {
      const updated = dbService.updateUserProfile(req.params.id, req.body);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/auth/user/:id/toggle-save/:caseId', (req, res) => {
    try {
      const saved = dbService.toggleSaveCase(req.params.id, req.params.caseId);
      res.json({ saved_cases: saved });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/auth/user/:id/my-work', (req, res) => {
    try {
      const summary = dbService.getUserWorkSummary(req.params.id);
      res.json(summary);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  // 1. Health check
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'NetSage AI',
      timestamp: new Date().toISOString(),
      gemini_configured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY')
    });
  });

  // 2. Get cases (with optional filters)
  app.get('/api/cases', (req, res) => {
    try {
      let cases = dbService.getAllCases();
      const { category, severity, osi_layer, search } = req.query;

      if (category && category !== 'ALL') {
        cases = cases.filter(c => c.category === category);
      }
      if (severity && severity !== 'ALL') {
        cases = cases.filter(c => c.severity === severity);
      }
      if (osi_layer && osi_layer !== 'ALL') {
        cases = cases.filter(c => c.osi_layer === Number(osi_layer));
      }
      if (search && typeof search === 'string' && search.trim().length > 0) {
        const q = search.toLowerCase().trim();
        cases = cases.filter(c =>
          c.symptom.toLowerCase().includes(q) ||
          c.topology_note.toLowerCase().includes(q) ||
          c.expected_fault.toLowerCase().includes(q) ||
          c.concept_tag.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q)
        );
      }

      res.json(cases);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch cases' });
    }
  });

  // 3. Get single case by ID
  app.get('/api/cases/:id', (req, res) => {
    try {
      const c = dbService.getCaseById(req.params.id);
      if (!c) {
        return res.status(404).json({ error: 'Case not found' });
      }
      res.json(c);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 4. Create new case manually
  app.post('/api/cases', (req, res) => {
    try {
      const { 
        symptom, 
        topology_note, 
        show_output, 
        expected_fault, 
        osi_layer, 
        concept_tag, 
        category, 
        severity,
        author_id,
        author_name,
        author_email
      } = req.body;
      if (!symptom || !show_output || !expected_fault || !category) {
        return res.status(400).json({ error: 'Missing required fields: symptom, show_output, expected_fault, category' });
      }

      const newCase = dbService.createCase({
        symptom,
        topology_note: topology_note || '',
        show_output,
        expected_fault,
        osi_layer: Number(osi_layer) || 3,
        concept_tag: concept_tag || 'custom-case',
        category,
        severity: severity || 'Medium',
        author_id: author_id || undefined,
        author_name: author_name || undefined,
        author_email: author_email || undefined
      });

      res.status(201).json(newCase);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 5. Bulk import cases
  app.post('/api/cases/bulk-import', (req, res) => {
    try {
      const { cases, author_id, author_name, author_email } = req.body;
      if (!Array.isArray(cases) || cases.length === 0) {
        return res.status(400).json({ error: 'Invalid cases array payload' });
      }

      const validCases = cases.map(c => ({
        symptom: c.symptom || 'Network anomaly observed',
        topology_note: c.topology_note || 'Imported network topology',
        show_output: c.show_output || 'show running-config',
        expected_fault: c.expected_fault || 'Unspecified configuration fault',
        osi_layer: Number(c.osi_layer) || 3,
        concept_tag: c.concept_tag || 'bulk-imported',
        category: c.category || 'Routing',
        severity: c.severity || 'Medium',
        author_id: author_id || undefined,
        author_name: author_name || undefined,
        author_email: author_email || undefined
      }));

      const result = dbService.bulkImportCases(validCases);
      res.status(201).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 6. Export cases as CSV
  app.get('/api/cases/export/csv', (_req, res) => {
    try {
      const cases = dbService.getAllCases();
      const headers = ['id', 'category', 'severity', 'osi_layer', 'concept_tag', 'symptom', 'topology_note', 'expected_fault', 'show_output', 'created_at'];
      
      const rows = cases.map(c => [
        c.id,
        c.category,
        c.severity,
        c.osi_layer,
        `"${(c.concept_tag || '').replace(/"/g, '""')}"`,
        `"${(c.symptom || '').replace(/"/g, '""')}"`,
        `"${(c.topology_note || '').replace(/"/g, '""')}"`,
        `"${(c.expected_fault || '').replace(/"/g, '""')}"`,
        `"${(c.show_output || '').replace(/"/g, '""')}"`,
        c.created_at
      ]);

      const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="cases.csv"');
      res.send(csvContent);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 7. Run Rule-Based Checker on a Case
  app.post('/api/cases/:id/run-rule-checker', (req, res) => {
    try {
      const caseItem = dbService.getCaseById(req.params.id);
      if (!caseItem) {
        return res.status(404).json({ error: 'Case not found' });
      }

      const results = runAllRuleChecks(caseItem);
      dbService.saveRuleCheckResults(results);

      res.json({
        case_id: caseItem.id,
        results: results,
        pass_count: results.filter(r => r.status === 'Pass').length,
        fail_count: results.filter(r => r.status === 'Fail').length
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 8. Run AI Diagnosis (Gemini)
  app.post('/api/cases/:id/diagnose', async (req, res) => {
    try {
      const { diagnosed_by_id, diagnosed_by_name } = req.body || {};
      const caseItem = dbService.getCaseById(req.params.id);
      if (!caseItem) {
        return res.status(404).json({ error: 'Case not found' });
      }

      const diagnosisData = await runAIDiagnosis(caseItem);
      const fullDiagnosis = {
        ...diagnosisData,
        id: `diag_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        created_at: new Date().toISOString(),
        diagnosed_by_id: diagnosed_by_id || undefined,
        diagnosed_by_name: diagnosed_by_name || undefined
      };

      const saved = dbService.saveAIDiagnosis(fullDiagnosis);
      res.status(201).json(saved);
    } catch (err: any) {
      console.error('Diagnosis error:', err);
      res.status(500).json({ error: err.message || 'Diagnosis generation failed' });
    }
  });

  // 9. Submit Human Review
  app.post('/api/diagnoses/:id/review', (req, res) => {
    try {
      const { reviewer_name, reviewer_id, verdict, corrected_root_cause, correction_explanation, case_id } = req.body;
      const diagnosisId = req.params.id;

      if (!verdict || !['Accepted', 'Edited', 'Rejected'].includes(verdict)) {
        return res.status(400).json({ error: 'Invalid verdict. Must be Accepted, Edited, or Rejected.' });
      }

      if ((verdict === 'Edited' || verdict === 'Rejected') && (!corrected_root_cause || !correction_explanation)) {
        return res.status(400).json({
          error: 'When verdict is Edited or Rejected, corrected_root_cause and correction_explanation are strictly required.'
        });
      }

      const review = {
        id: `rev_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        diagnosis_id: diagnosisId,
        case_id: case_id,
        reviewer_name: reviewer_name || 'Anonymous Reviewer',
        reviewer_id: reviewer_id || undefined,
        verdict,
        corrected_root_cause: (verdict === 'Edited' || verdict === 'Rejected') ? corrected_root_cause : null,
        correction_explanation: (verdict === 'Edited' || verdict === 'Rejected') ? correction_explanation : null,
        reviewed_at: new Date().toISOString()
      };

      const saved = dbService.saveReview(review);
      res.status(201).json(saved);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 10. Responsible AI Log
  app.get('/api/responsible-ai-log', (_req, res) => {
    try {
      const logs = dbService.getResponsibleAiLog();
      res.json({
        total_entries: logs.length,
        meets_requirement: logs.length >= 5,
        entries: logs
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 11. Responsible AI Log CSV export
  app.get('/api/responsible-ai-log/export/csv', (_req, res) => {
    try {
      const logs = dbService.getResponsibleAiLog();
      const headers = ['id', 'case_id', 'category', 'verdict', 'reviewer_name', 'ai_root_cause', 'ai_confidence', 'corrected_root_cause', 'correction_explanation', 'reviewed_at'];
      
      const rows = logs.map(l => [
        l.id,
        l.case_id,
        l.case_category,
        l.verdict,
        `"${(l.reviewer_name || '').replace(/"/g, '""')}"`,
        `"${(l.ai_root_cause || '').replace(/"/g, '""')}"`,
        l.ai_confidence,
        `"${(l.corrected_root_cause || '').replace(/"/g, '""')}"`,
        `"${(l.correction_explanation || '').replace(/"/g, '""')}"`,
        l.reviewed_at
      ]);

      const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="responsible_ai_log.csv"');
      res.send(csvContent);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 12. Dashboard Statistics
  app.get('/api/dashboard/stats', (_req, res) => {
    try {
      const stats = dbService.getDashboardStats();
      res.json(stats);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 13. Prompt template CRUD
  app.get('/api/prompt-template', (_req, res) => {
    try {
      const template = getPromptTemplate();
      res.json({ template });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/prompt-template', (req, res) => {
    try {
      const { template } = req.body;
      if (!template || typeof template !== 'string') {
        return res.status(400).json({ error: 'Template content string is required' });
      }
      savePromptTemplate(template);
      res.json({ status: 'success', message: 'Prompt template saved' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 14. Reset database to initial seed
  app.post('/api/reset-seed', (_req, res) => {
    try {
      dbService.reseed();
      res.json({ status: 'ok', message: 'Database reset to 36 seed cases and 6 Responsible AI logs.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 15. Standalone Rule Checker Script & Sample Output Deliverable
  app.get('/api/rule-checker/standalone-export', (_req, res) => {
    const cases = dbService.getAllCases();
    const sampleResults = cases.slice(0, 3).map(c => ({
      case_id: c.id,
      symptom: c.symptom,
      rule_check_results: runAllRuleChecks(c)
    }));

    res.json({
      description: 'NetSage AI Deterministic Rule Checker Deliverable',
      rules_implemented: [
        'duplicate_ip: Scans for duplicate IP addresses in configs, interfaces, and syslog',
        'wrong_subnet_mask: Detects inverted OSPF/ACL wildcard masks and point-to-point /30 mask mismatches',
        'gateway_mismatch: Identifies default gateways in different subnets than host or switch SVI',
        'interface_down: Detects administratively down, line protocol down, and shutdown interfaces',
        'missing_vlan: Detects access ports assigned to non-existent VLANs and trunk allowed VLAN omissions',
        'missing_route: Identifies missing default routes (0.0.0.0/0) and unadvertised OSPF/EIGRP networks'
      ],
      sample_output: sampleResults
    });
  });

  // 16. Network Monitor & Automated Alert Simulation
  app.get('/api/network-monitor/status', (_req, res) => {
    const alerts: NetworkAlert[] = [
      {
        id: 'alt_01',
        timestamp: new Date(Date.now() - 1000 * 45).toISOString(),
        device_name: 'SW-Core-Floor1',
        interface_name: 'FastEthernet0/5',
        severity: 'Critical',
        message: 'Port Fa0/5 flapping; assigned to VLAN 20 but connected host expects VLAN 10 (Engineering)',
        category: 'VLAN'
      },
      {
        id: 'alt_02',
        timestamp: new Date(Date.now() - 1000 * 120).toISOString(),
        device_name: 'Router-Edge-01',
        interface_name: 'GigabitEthernet0/0/0',
        severity: 'Critical',
        message: 'Line protocol is down; Interface GigabitEthernet0/0/0 is administratively down',
        category: 'Gateway'
      },
      {
        id: 'alt_03',
        timestamp: new Date(Date.now() - 1000 * 240).toISOString(),
        device_name: 'R-Branch-DHCP',
        interface_name: 'Vlan10',
        severity: 'Warning',
        message: 'DHCP scope pool POOL_BRANCH reached 100% address allocation; 0 free leases',
        category: 'DHCP'
      },
      {
        id: 'alt_04',
        timestamp: new Date(Date.now() - 1000 * 360).toISOString(),
        device_name: 'WAP-Corp-03',
        interface_name: 'dot11Radio0',
        severity: 'Warning',
        message: 'Client 4-Way Handshake timeout on SSID CORP_SECURE; PSK passphrase rejection',
        category: 'Wireless'
      }
    ];

    res.json({
      devices_online: 18,
      devices_degraded: 3,
      packet_rate_pps: 14250,
      active_alerts: alerts
    });
  });

  // 17. Simulate Live Network Incident (auto-converts alert to new Case)
  app.post('/api/network-monitor/simulate-incident', (req, res) => {
    try {
      const { type } = req.body;
      let incidentData: Omit<NetworkCase, 'id' | 'created_at'>;

      if (type === 'vlan_storm') {
        incidentData = {
          symptom: 'Broadcast storm detected on SW-Agg-01; Trunk port Gi0/2 native VLAN mismatch with neighbor.',
          topology_note: 'SW-Agg-01 (Gi0/2 Native 99) <==Trunk==> SW-Core-02 (Gi0/2 Native 1)',
          show_output: `SW-Agg-01# show interfaces trunk
Port        Mode             Encapsulation  Status        Native vlan
Gi0/2       on               802.1q         trunking      99
%CDP-4-NATIVE_VLAN_MISMATCH: Native VLAN mismatch detected on GigabitEthernet0/2 (99), with SW-Core-02 GigabitEthernet0/2 (1).`,
          expected_fault: 'Native VLAN mismatch on trunk link Gi0/2 between SW-Agg-01 (VLAN 99) and SW-Core-02 (VLAN 1).',
          osi_layer: 2,
          concept_tag: 'live-incident-native-vlan-mismatch',
          category: 'VLAN',
          severity: 'High'
        };
      } else if (type === 'ospf_dead') {
        incidentData = {
          symptom: 'OSPF adjacency dropped on WAN link Serial0/0/1; area mismatch error logged.',
          topology_note: 'R-HQ (Se0/0/1 Area 0) <==T1 Link==> R-Branch-04 (Se0/0/1 Area 5)',
          show_output: `R-HQ# show ip ospf interface Serial0/0/1
Serial0/0/1 is up, line protocol is up
  Internet Address 10.254.1.1/30, Area 0
%OSPF-4-ERRRCV: Received packet from 10.254.1.2, Area 5, mismatched Area ID in packet from Serial0/0/1`,
          expected_fault: 'OSPF Area ID mismatch on Serial0/0/1 link between R-HQ (Area 0) and R-Branch-04 (Area 5).',
          osi_layer: 3,
          concept_tag: 'live-incident-ospf-area-mismatch',
          category: 'Routing',
          severity: 'High'
        };
      } else {
        incidentData = {
          symptom: 'Default gateway unreachable from Marketing subnet 192.168.45.0/24 after maintenance reload.',
          topology_note: 'Marketing PC (192.168.45.20/24) -> Router R-Edge (Gi0/0/2: 192.168.45.1)',
          show_output: `R-Edge# show ip interface brief
Interface              IP-Address      OK? Method Status                Protocol
GigabitEthernet0/0/2   192.168.45.1    YES manual administratively down down`,
          expected_fault: 'Interface GigabitEthernet0/0/2 is administratively down (shutdown state after reload).',
          osi_layer: 1,
          concept_tag: 'live-incident-interface-admin-down',
          category: 'Gateway',
          severity: 'High'
        };
      }

      const created = dbService.createCase(incidentData);
      res.status(201).json({
        message: 'Live incident successfully created as a new case and evaluated by rule checker.',
        case: created
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== PACKET TRACER (.PKT) DIAGNOSTICS ====================

  // 18. Analyze uploaded .PKT file or Packet Tracer topology
  app.post('/api/pkt/analyze', async (req, res) => {
    try {
      const { fileName, fileContent, fileSizeBytes, isBase64 } = req.body;
      if (!fileContent && typeof fileContent !== 'string') {
        return res.status(400).json({ error: 'fileContent (base64 or text) is required.' });
      }

      const safeFileName = (fileName && typeof fileName === 'string' && fileName.trim().length > 0)
        ? fileName.trim()
        : 'topology.pkt';

      const size = Number(fileSizeBytes) || (fileContent ? fileContent.length : 1024);

      // Parse file contents into text & structured topology
      const { rawText, topology } = await parsePktFileContent(safeFileName, fileContent);

      // Run AI Diagnosis & Remediations
      const diagnosisResult = await diagnosePktTopology(safeFileName, size, rawText, topology);

      res.json(diagnosisResult);
    } catch (err: any) {
      console.error('Error analyzing PKT file:', err);
      res.status(500).json({ error: err.message || 'Failed to analyze Packet Tracer file' });
    }
  });

  // 19. Sample Packet Tracer Scenarios for 1-click exploration
  app.get('/api/pkt/samples', (_req, res) => {
    const samples = [
      {
        id: 'sample_ospf_mismatch',
        name: 'Enterprise_Branch_OSPF_Area_Mismatch.pkt',
        category: 'Routing',
        severity: 'High',
        description: 'Branch router R2 is unable to form OSPF adjacency with HQ Core R1 due to mismatched Area 10 configuration and passive-interface on the transit link.',
        size: '14.2 KB',
        fileContent: `! Cisco Packet Tracer 8.2 Topology Configuration
! Devices: R1_HQ_Core, R2_Branch_Edge, SW1_Core, PC1_Admin
hostname R1_HQ_Core
!
interface GigabitEthernet0/0/0
 ip address 10.100.1.1 255.255.255.252
 duplex auto
 speed auto
!
interface GigabitEthernet0/0/1
 ip address 192.168.10.1 255.255.255.0
!
router ospf 1
 router-id 1.1.1.1
 network 10.100.1.0 0.0.0.3 area 0
 network 192.168.10.0 0.0.0.255 area 0
!
hostname R2_Branch_Edge
!
interface GigabitEthernet0/0/0
 ip address 10.100.1.2 255.255.255.252
 duplex auto
 speed auto
!
router ospf 1
 router-id 2.2.2.2
 passive-interface GigabitEthernet0/0/0
 network 10.100.1.0 0.0.0.3 area 10
!
! SYMPTOM & LOG:
! %OSPF-4-ERRRCV: Received packet from 10.100.1.1, Area 0, mismatched Area ID in packet from GigabitEthernet0/0/0
! R2# show ip ospf neighbor -> Empty (Adjacency DOWN)`
      },
      {
        id: 'sample_vlan_native',
        name: 'Campus_Switching_Native_VLAN_Mismatch.pkt',
        category: 'VLAN',
        severity: 'Medium',
        description: 'Core Switch SW-Core-01 and Access Switch SW-Acc-02 experience STP unforwarding state and packet leakage due to mismatched 802.1Q Native VLANs and missing VLAN 30.',
        size: '18.6 KB',
        fileContent: `! Cisco Packet Tracer 8.2 Campus Switching Topology
hostname SW_Core_01
!
vlan 10
 name Sales_Data
vlan 20
 name Engineering
vlan 99
 name Management_Native
!
interface GigabitEthernet0/1
 switchport mode trunk
 switchport trunk native vlan 99
 switchport trunk allowed vlan 10,20,99
!
hostname SW_Acc_02
!
vlan 10
 name Sales_Data
! Note: VLAN 30 and VLAN 99 are NOT created in local database
interface GigabitEthernet0/1
 switchport mode trunk
 switchport trunk native vlan 1
 switchport trunk allowed vlan 10,20
!
interface FastEthernet0/5
 switchport mode access
 switchport access vlan 30
!
! LOGS:
! %CDP-4-NATIVE_VLAN_MISMATCH: Native VLAN mismatch detected on GigabitEthernet0/1 (99), with SW_Acc_02 GigabitEthernet0/1 (1).
! %SPANTREE-2-RECV_PVID_ERR: Received BPDU with inconsistent peer vlan id 1 on GigabitEthernet0/1 native vlan 99. Blocking port.`
      },
      {
        id: 'sample_acl_dhcp_drop',
        name: 'Security_Border_ACL_Blocking_DHCP.pkt',
        category: 'ACL',
        severity: 'High',
        description: 'Border gateway router applies an inbound traffic filter that inadvertently drops DHCP Discover broadcasts (UDP 67/68), causing all workstations to receive 169.254.x.x APIPA addresses.',
        size: '12.8 KB',
        fileContent: `! Cisco Packet Tracer Security Topology
hostname R_Gateway
!
interface GigabitEthernet0/0
 description LAN Interface
 ip address 192.168.50.1 255.255.255.0
 ip access-group INBOUND_FILTER in
!
ip access-list extended INBOUND_FILTER
 permit tcp 192.168.50.0 0.0.0.255 any eq 80
 permit tcp 192.168.50.0 0.0.0.255 any eq 443
 permit icmp 192.168.50.0 0.0.0.255 any
! Implicit Deny Any Any drops DHCP (UDP 67/68) and DNS (UDP 53)
!
ip dhcp pool CORPORATE_LAN
 network 192.168.50.0 255.255.255.0
 default-router 192.168.50.1
 dns-server 8.8.8.8
!
! SHOW OUTPUT / SYMPTOM:
! Workstation PC1 IP Configuration: DHCP Failed. APIPA is being used (169.254.120.45 / 255.255.0.0).`
      },
      {
        id: 'sample_nat_overload',
        name: 'Edge_Router_PAT_Overload_Failure.pkt',
        category: 'NAT',
        severity: 'High',
        description: 'Edge router PAT translation fails for internal hosts because the "overload" keyword is omitted from the NAT statement, exhausting the pool on the first single connection.',
        size: '15.1 KB',
        fileContent: `! Cisco Packet Tracer NAT Lab
hostname R_Edge_NAT
!
interface GigabitEthernet0/0
 description Inside LAN
 ip address 172.16.10.1 255.255.255.0
 ip nat inside
!
interface Serial0/0/0
 description ISP WAN Uplink
 ip address 203.0.113.2 255.255.255.252
 ip nat outside
!
access-list 1 permit 172.16.10.0 0.0.0.255
!
! FAULTY CONFIG: Missing "overload" keyword for Port Address Translation
ip nat inside source list 1 interface Serial0/0/0
!
! SYMPTOM & LOG:
! Host 172.16.10.5 connects successfully to Public Web Server, but all subsequent hosts (172.16.10.6, .7) fail with "Destination Host Unreachable".
! show ip nat translations -> Only 1 static allocation available.`
      }
    ];

    res.json(samples);
  });

  // 20. Convert diagnosed PKT results into a permanent NetworkCase in database
  app.post('/api/pkt/save-as-case', (req, res) => {
    try {
      const { 
        pktDiagnosis, 
        author_id, 
        author_name, 
        author_email 
      } = req.body;

      if (!pktDiagnosis || !pktDiagnosis.detected_faults || pktDiagnosis.detected_faults.length === 0) {
        return res.status(400).json({ error: 'Valid PKT diagnosis with detected faults is required.' });
      }

      const primaryFault = pktDiagnosis.detected_faults[0];
      const allRemediations = pktDiagnosis.device_remediations.map(r => 
        `! Device: ${r.device_name}\n${r.cli_commands_script}`
      ).join('\n\n');

      const newCase = dbService.createCase({
        symptom: `[PKT Audit: ${pktDiagnosis.file_name}] ${primaryFault.problem_description || primaryFault.title}`,
        topology_note: `Packet Tracer Topology: ${pktDiagnosis.topology.total_devices} devices (${pktDiagnosis.topology.devices.map((d: any) => d.name).join(', ')})`,
        show_output: `! Extracted Packet Tracer Running Configuration & Diagnostics from ${pktDiagnosis.file_name}\n\n${pktDiagnosis.raw_extracted_text.slice(0, 3000)}\n\n! Faulty Configuration Lines:\n${primaryFault.faulty_config_lines.join('\n')}`,
        expected_fault: `${primaryFault.title} (${primaryFault.explanation})`,
        osi_layer: primaryFault.osi_layer || 3,
        concept_tag: `pkt-upload-${primaryFault.category.toLowerCase()}`,
        category: primaryFault.category,
        severity: primaryFault.severity || 'High',
        author_id: author_id || undefined,
        author_name: author_name || undefined,
        author_email: author_email || undefined
      });

      // Also create an initial AIDiagnosis record for this case
      const aiDiag = dbService.saveAIDiagnosis({
        id: `diag_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        case_id: newCase.id,
        root_cause: `${primaryFault.title}: ${primaryFault.explanation}`,
        osi_layer: primaryFault.osi_layer,
        confidence: 'High',
        evidence: primaryFault.faulty_config_lines.join(' | ') || `Packet tracer configuration analysis on ${primaryFault.device_name}`,
        next_command: primaryFault.verification_command || 'show running-config',
        fix_steps: primaryFault.recommended_fix_commands.length > 0 
          ? primaryFault.recommended_fix_commands 
          : pktDiagnosis.remediation_steps,
        raw_response: JSON.stringify(pktDiagnosis, null, 2),
        diagnosed_by_id: author_id,
        diagnosed_by_name: author_name,
        created_at: new Date().toISOString()
      });

      // Run rule checks automatically
      const ruleResults = runAllRuleChecks(newCase);
      dbService.saveRuleCheckResults(ruleResults);

      res.status(201).json({
        message: 'Packet Tracer diagnosis successfully saved as a persistent case in your workspace.',
        case_id: newCase.id,
        case: newCase,
        diagnosis_id: aiDiag.id
      });
    } catch (err: any) {
      console.error('Error saving PKT as case:', err);
      res.status(500).json({ error: err.message || 'Failed to save case from PKT diagnosis' });
    }
  });

  // ==================== VITE MIDDLEWARE ====================
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`NetSage AI Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
