<?php
// ============================================================
//  MediCheck — Reports & Alerts API
//  api/reports.php
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
    // SUBMIT REPORT
    // ----------------------------------------------------------
    case 'submit':
        $drugName   = trim($body['drug_name']   ?? '');
        $drugId     = trim($body['drug_id']     ?? '');
        $seller     = trim($body['seller_name'] ?? '');
        $location   = trim($body['location']    ?? '');
        $severity   = $body['severity']         ?? 'medium';
        $description= trim($body['description'] ?? '');

        if (!$drugName && !$drugId) {
            jsonResponse(false, 'Drug name or ID is required', [], 400);
        }
        if (!in_array($severity, ['low','medium','high'])) $severity = 'medium';

        $db         = getDB();
        $reportedBy = $_SESSION['user']['id'] ?? null;

        $stmt = $db->prepare("
            INSERT INTO reports (reported_by, drug_id, drug_name, seller_name, location, severity, description)
            VALUES (?,?,?,?,?,?,?)
        ");
        $stmt->execute([$reportedBy, $drugId ?: null, $drugName, $seller, $location, $severity, $description]);

        // Create alert for admin
        $db->prepare("
            INSERT INTO alerts (drug_id, alert_type, severity, title, message, location)
            VALUES (?,?,?,?,?,?)
        ")->execute([
            $drugId ?: null,
            'report',
            $severity === 'high' ? 'critical' : ($severity === 'medium' ? 'warning' : 'info'),
            "User report: {$drugName}",
            "Seller: {$seller}. {$description}",
            $location,
        ]);

        jsonResponse(true, 'Report submitted. Our team will investigate.', [], 201);
        break;

    // ----------------------------------------------------------
    // LIST REPORTS (admin)
    // ----------------------------------------------------------
    case 'list':
        requireAuth('admin');
        $db   = getDB();
        $stmt = $db->prepare("
            SELECT r.*, u.name AS reporter_name, u.email AS reporter_email
            FROM reports r
            LEFT JOIN users u ON r.reported_by = u.id
            ORDER BY r.created_at DESC
            LIMIT 50
        ");
        $stmt->execute();
        jsonResponse(true, '', ['reports' => $stmt->fetchAll()]);
        break;

    // ----------------------------------------------------------
    // UPDATE REPORT STATUS (admin)
    // ----------------------------------------------------------
    case 'update':
        requireAuth('admin');
        $id     = (int)($body['id']          ?? 0);
        $status = $body['status']            ?? '';
        $notes  = trim($body['admin_notes']  ?? '');

        if (!$id || !in_array($status, ['investigating','resolved','dismissed'])) {
            jsonResponse(false, 'Invalid id or status', [], 400);
        }

        $db = getDB();
        $db->prepare("UPDATE reports SET status=?, admin_notes=? WHERE id=?")
           ->execute([$status, $notes, $id]);
        jsonResponse(true, 'Report updated');
        break;

    // ----------------------------------------------------------
    // LIST ALERTS (admin)
    // ----------------------------------------------------------
    case 'alerts':
        requireAuth('admin');
        $db   = getDB();
        $stmt = $db->query("
            SELECT a.*, d.drug_name
            FROM alerts a
            LEFT JOIN drugs d ON a.drug_id = d.drug_id
            ORDER BY a.created_at DESC
            LIMIT 50
        ");
        jsonResponse(true, '', ['alerts' => $stmt->fetchAll()]);
        break;

    // ----------------------------------------------------------
    // RESOLVE ALERT (admin)
    // ----------------------------------------------------------
    case 'resolve_alert':
        requireAuth('admin');
        $id = (int)($body['id'] ?? 0);
        if (!$id) jsonResponse(false, 'id required', [], 400);

        getDB()->prepare("UPDATE alerts SET status='resolved' WHERE id=?")->execute([$id]);
        jsonResponse(true, 'Alert resolved');
        break;

    // ----------------------------------------------------------
    // USER SCAN HISTORY
    // ----------------------------------------------------------
    case 'history':
        $user = requireAuth();
        $db   = getDB();

        $stmt = $db->prepare("
            SELECT s.*, d.drug_name, d.dosage_strength, d.category,
                   u.name AS manufacturer_name
            FROM scans s
            LEFT JOIN drugs d ON s.drug_id = d.drug_id
            LEFT JOIN users u ON d.manufacturer_id = u.id
            WHERE s.scanned_by = ?
            ORDER BY s.scanned_at DESC
            LIMIT 50
        ");
        $stmt->execute([$user['id']]);
        jsonResponse(true, '', ['history' => $stmt->fetchAll()]);
        break;

    default:
        jsonResponse(false, 'Unknown action', [], 400);
}
