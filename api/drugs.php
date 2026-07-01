<?php
// ============================================================
//  MediCheck — Drugs API
//  api/drugs.php
//  Actions: register | list | verify | detail | block | stats
// ============================================================
session_start();
require_once __DIR__ . '/config.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

$body   = json_decode(file_get_contents('php://input'), true) ?? [];
$action = $_GET['action'] ?? $body['action'] ?? '';

switch ($action) {

    // ----------------------------------------------------------
    // REGISTER — manufacturer adds a new drug
    // ----------------------------------------------------------
    case 'register':
        $user = requireAuth('manufacturer', 'admin');
        $db   = getDB();

        $required = ['drug_name','batch_number','manufacture_date','expiry_date'];
        foreach ($required as $field) {
            if (empty($body[$field])) {
                jsonResponse(false, "Field '{$field}' is required", [], 400);
            }
        }

        // Generate unique drug ID
        do {
            $drugId = generateDrugId();
            $chk = $db->prepare("SELECT id FROM drugs WHERE drug_id = ?");
            $chk->execute([$drugId]);
        } while ($chk->fetch());

        $qrPayload = json_encode([
            'id'           => $drugId,
            'drug'         => $body['drug_name'],
            'manufacturer' => $user['company'] ?: $user['name'],
            'batch'        => $body['batch_number'],
            'system'       => 'MediCheck',
            'ts'           => date('c'),
        ]);

        $stmt = $db->prepare("
            INSERT INTO drugs
              (drug_id, manufacturer_id, drug_name, generic_name, category,
               dosage_strength, dosage_form, batch_number, manufacture_date,
               expiry_date, batch_quantity, storage_conditions, nafdac_number,
               description, qr_payload)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ");
        $stmt->execute([
            $drugId,
            $user['id'],
            trim($body['drug_name']),
            trim($body['generic_name']       ?? ''),
            trim($body['category']           ?? ''),
            trim($body['dosage_strength']    ?? ''),
            $body['dosage_form']             ?? 'Tablet',
            trim($body['batch_number']),
            $body['manufacture_date'],
            $body['expiry_date'],
            (int)($body['batch_quantity']    ?? 0),
            trim($body['storage_conditions'] ?? ''),
            trim($body['nafdac_number']      ?? ''),
            trim($body['description']        ?? ''),
            $qrPayload,
        ]);

        jsonResponse(true, 'Drug registered successfully', [
            'drug_id'    => $drugId,
            'qr_payload' => $qrPayload,
        ], 201);
        break;

    // ----------------------------------------------------------
    // LIST — manufacturer sees their drugs
    // ----------------------------------------------------------
    case 'list':
        $user = requireAuth('manufacturer', 'admin');
        $db   = getDB();

        if ($user['role'] === 'admin') {
            $stmt = $db->prepare("
                SELECT d.*, u.name AS manufacturer_name,
                       (SELECT COUNT(*) FROM scans s WHERE s.drug_id = d.drug_id) AS scan_count
                FROM drugs d
                JOIN users u ON d.manufacturer_id = u.id
                ORDER BY d.created_at DESC
            ");
            $stmt->execute();
        } else {
            $stmt = $db->prepare("
                SELECT d.*,
                       (SELECT COUNT(*) FROM scans s WHERE s.drug_id = d.drug_id) AS scan_count
                FROM drugs d
                WHERE d.manufacturer_id = ?
                ORDER BY d.created_at DESC
            ");
            $stmt->execute([$user['id']]);
        }

        jsonResponse(true, '', ['drugs' => $stmt->fetchAll()]);
        break;

    // ----------------------------------------------------------
    // VERIFY — scan a QR code
    // ----------------------------------------------------------
    case 'verify':
        $drugId = trim($body['drug_id'] ?? $_GET['drug_id'] ?? '');
        if (!$drugId) {
            jsonResponse(false, 'drug_id is required', [], 400);
        }

        $db   = getDB();
        $stmt = $db->prepare("
            SELECT d.*, u.name AS manufacturer_name, u.company AS manufacturer_company
            FROM drugs d
            JOIN users u ON d.manufacturer_id = u.id
            WHERE d.drug_id = ?
            LIMIT 1
        ");
        $stmt->execute([$drugId]);
        $drug = $stmt->fetch();

        if (!$drug) {
            // Record unknown scan
            $loc = trim($body['location'] ?? '');
            $db->prepare("INSERT INTO scans (drug_id, result, location, ip_address, ai_confidence) VALUES (?,?,?,?,?)")
               ->execute([$drugId, 'unknown', $loc, $_SERVER['REMOTE_ADDR'] ?? '', 0]);
            jsonResponse(true, 'Drug not found in database', [
                'result'     => 'unknown',
                'confidence' => 0,
                'signals'    => [['type'=>'red','text'=>'Drug ID not registered in MediCheck database']],
                'drug'       => null,
            ]);
        }

        // Blocked drug
        if ($drug['status'] === 'blocked') {
            jsonResponse(true, '', [
                'result'     => 'suspect',
                'confidence' => 99.0,
                'signals'    => [['type'=>'red','text'=>'This drug has been BLOCKED by administrators']],
                'drug'       => $drug,
            ]);
        }

        // Check expiry
        $expired = strtotime($drug['expiry_date']) < time();

        // Run AI analysis
        $ai = analysePattern($drugId, $db, $drug);

        // If expired, downgrade to suspect
        if ($expired && $ai['result'] === 'genuine') {
            $ai['result']     = 'suspect';
            $ai['confidence'] = 85.0;
            array_unshift($ai['signals'], ['type'=>'red','text'=>'Product has EXPIRED — do not use']);
        }

        // Record scan
        $scannedBy = $_SESSION['user']['id'] ?? null;
        $location  = trim($body['location'] ?? '');
        $db->prepare("
            INSERT INTO scans (drug_id, scanned_by, result, ai_confidence, location, ip_address)
            VALUES (?,?,?,?,?,?)
        ")->execute([$drugId, $scannedBy, $ai['result'], $ai['confidence'], $location, $_SERVER['REMOTE_ADDR'] ?? '']);

        // Auto-create alert if suspect
        if ($ai['result'] === 'suspect') {
            $recentSuspect = $db->prepare(
                "SELECT id FROM alerts WHERE drug_id = ? AND created_at >= NOW() - INTERVAL 1 HOUR LIMIT 1"
            );
            $recentSuspect->execute([$drugId]);
            if (!$recentSuspect->fetch()) {
                $db->prepare("
                    INSERT INTO alerts (drug_id, alert_type, severity, title, message, location)
                    VALUES (?,?,?,?,?,?)
                ")->execute([
                    $drugId,
                    'unusual_pattern',
                    'critical',
                    'Suspicious scan detected: ' . $drug['drug_name'],
                    "AI flagged drug {$drugId} as suspect. Confidence: {$ai['confidence']}%",
                    $location,
                ]);
            }
        }

        jsonResponse(true, '', [
            'result'      => $ai['result'],
            'confidence'  => $ai['confidence'],
            'signals'     => $ai['signals'],
            'total_scans' => $ai['total_scans'],
            'method'      => $ai['method'] ?? 'rules',
            'drug'        => $drug,
        ]);
        break;

    // ----------------------------------------------------------
    // DETAIL — full drug info
    // ----------------------------------------------------------
    case 'detail':
        $drugId = trim($_GET['drug_id'] ?? '');
        if (!$drugId) jsonResponse(false, 'drug_id required', [], 400);

        $db   = getDB();
        $stmt = $db->prepare("
            SELECT d.*, u.name AS manufacturer_name, u.company AS manufacturer_company,
                   (SELECT COUNT(*) FROM scans s WHERE s.drug_id = d.drug_id) AS scan_count
            FROM drugs d
            JOIN users u ON d.manufacturer_id = u.id
            WHERE d.drug_id = ?
        ");
        $stmt->execute([$drugId]);
        $drug = $stmt->fetch();
        if (!$drug) jsonResponse(false, 'Drug not found', [], 404);

        jsonResponse(true, '', ['drug' => $drug]);
        break;

    // ----------------------------------------------------------
    // BLOCK — admin blocks a drug
    // ----------------------------------------------------------
    case 'block':
        requireAuth('admin');
        $drugId = trim($body['drug_id'] ?? '');
        if (!$drugId) jsonResponse(false, 'drug_id required', [], 400);

        $db = getDB();
        $db->prepare("UPDATE drugs SET status='blocked' WHERE drug_id=?")->execute([$drugId]);
        $db->prepare("
            INSERT INTO alerts (drug_id, alert_type, severity, title, message)
            VALUES (?,?,?,?,?)
        ")->execute([$drugId,'blocked','critical',"Drug Blocked: {$drugId}","Drug has been blocked by administrator"]);

        jsonResponse(true, 'Drug blocked successfully');
        break;

    // ----------------------------------------------------------
    // STATS — admin dashboard numbers
    // ----------------------------------------------------------
    case 'stats':
        requireAuth('admin');
        $db = getDB();

        $stats = [];

        // Total drugs
        $stats['total_drugs'] = (int)$db->query("SELECT COUNT(*) FROM drugs")->fetchColumn();

        // Total scans today
        $stats['scans_today'] = (int)$db->query(
            "SELECT COUNT(*) FROM scans WHERE DATE(scanned_at) = CURDATE()"
        )->fetchColumn();

        // Total scans all time
        $stats['total_scans'] = (int)$db->query("SELECT COUNT(*) FROM scans")->fetchColumn();

        // Suspect scans
        $stats['suspect_count'] = (int)$db->query(
            "SELECT COUNT(*) FROM scans WHERE result='suspect'"
        )->fetchColumn();

        // Genuine scans
        $stats['genuine_count'] = (int)$db->query(
            "SELECT COUNT(*) FROM scans WHERE result='genuine'"
        )->fetchColumn();

        // Active alerts
        $stats['active_alerts'] = (int)$db->query(
            "SELECT COUNT(*) FROM alerts WHERE status='active'"
        )->fetchColumn();

        // Pending reports
        $stats['pending_reports'] = (int)$db->query(
            "SELECT COUNT(*) FROM reports WHERE status='pending'"
        )->fetchColumn();

        // Total manufacturers
        $stats['manufacturers'] = (int)$db->query(
            "SELECT COUNT(*) FROM users WHERE role='manufacturer'"
        )->fetchColumn();

        // Weekly scans (last 7 days)
        $weekly = $db->query("
            SELECT DATE(scanned_at) as day, COUNT(*) as count
            FROM scans
            WHERE scanned_at >= CURDATE() - INTERVAL 6 DAY
            GROUP BY DATE(scanned_at)
            ORDER BY day ASC
        ")->fetchAll();
        $stats['weekly_scans'] = $weekly;

        jsonResponse(true, '', ['stats' => $stats]);
        break;

    case 'map':
        $db = getDB();

        $stmt = $db->query("
            SELECT location, COUNT(*) AS total
            FROM scans
            WHERE location IS NOT NULL AND location != ''
            GROUP BY location
            ORDER BY total DESC
        ");

        jsonResponse(true, '', [
            'map' => $stmt->fetchAll()
        ]);
        break;

    default:
        jsonResponse(false, 'Unknown action', [], 400);
}

