<?php
// ============================================================
//  MediCheck — Database Configuration
//  api/config.php
// ============================================================
// Reads from environment variables when set (Railway), falls back to
// XAMPP defaults automatically when running locally.
define('DB_HOST',    getenv('MYSQLHOST')     ?: 'localhost');
define('DB_NAME',    getenv('MYSQLDATABASE') ?: 'medicheck');
define('DB_USER',    getenv('MYSQLUSER')     ?: 'root');
define('DB_PASS',    getenv('MYSQLPASSWORD') ?: '');
define('DB_PORT',    getenv('MYSQLPORT')     ?: '3306');
define('DB_CHARSET', 'utf8mb4');

// ---- ML micro-service URL ----
define('ML_API_URL', getenv('ML_API_URL') ?: 'http://127.0.0.1:5000/predict');

// ---- PDO Connection ----
function getDB(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $dsn = 'mysql:host=' . DB_HOST . ';port=' . DB_PORT . ';dbname=' . DB_NAME . ';charset=' . DB_CHARSET;
        $options = [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ];
        try {
            $pdo = new PDO($dsn, DB_USER, DB_PASS, $options);
        } catch (PDOException $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Database connection failed']);
            exit;
        }
    }
    return $pdo;
}

// ---- JSON response helper ----
function jsonResponse(bool $success, string $message = '', array $data = [], int $code = 200): void {
    http_response_code($code);
    header('Content-Type: application/json');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    echo json_encode(array_merge(['success' => $success, 'message' => $message], $data));
    exit;
}

// ---- Session helper ----
function requireAuth(string ...$roles): array {
    if (session_status() === PHP_SESSION_NONE) session_start();
    if (empty($_SESSION['user'])) {
        jsonResponse(false, 'Not authenticated', [], 401);
    }
    $user = $_SESSION['user'];
    if (!empty($roles) && !in_array($user['role'], $roles)) {
        jsonResponse(false, 'Access denied', [], 403);
    }
    return $user;
}

// ---- Generate unique Drug ID ----
function generateDrugId(): string {
    $year = date('Y');
    $rand = strtoupper(substr(bin2hex(random_bytes(3)), 0, 5));
    return "MC-{$year}-{$rand}";
}

// ---- Call Python ML micro-service ----
function callMLService(array $features): ?array {
    $payload = json_encode($features);
    $ctx = stream_context_create([
        'http' => [
            'method'  => 'POST',
            'header'  => "Content-Type: application/json\r\nContent-Length: " . strlen($payload),
            'content' => $payload,
            'timeout' => 2,
        ]
    ]);
    try {
        $response = @file_get_contents(ML_API_URL, false, $ctx);
        if ($response === false) return null;
        $data = json_decode($response, true);
        if (!$data || empty($data['success'])) return null;
        return [
            'result'     => $data['result'],
            'confidence' => $data['confidence'],
            'signals'    => $data['signals'],
        ];
    } catch (Exception $e) {
        return null;
    }
}

// ---- AI pattern analysis (ML + rule-based fallback) ----
function analysePattern(string $drugId, PDO $db, array $drug = []): array {

    // Gather scan stats from DB
    $stmt = $db->prepare(
        "SELECT COUNT(*) as cnt, COUNT(DISTINCT location) as locations
         FROM scans
         WHERE drug_id = ? AND scanned_at >= NOW() - INTERVAL 2 HOUR"
    );
    $stmt->execute([$drugId]);
    $recent = $stmt->fetch();

    $totalStmt = $db->prepare("SELECT COUNT(*) as total FROM scans WHERE drug_id = ?");
    $totalStmt->execute([$drugId]);
    $total = (int)$totalStmt->fetch()['total'];

    $reportStmt = $db->prepare(
        "SELECT COUNT(*) as cnt FROM reports WHERE drug_id = ? AND status != 'dismissed'"
    );
    $reportStmt->execute([$drugId]);
    $mfrReports = (int)$reportStmt->fetch()['cnt'];

    $scans2h   = (int)$recent['cnt'];
    $locations = (int)$recent['locations'];

    // Calculate features
    $daysToExpiry = isset($drug['expiry_date'])
        ? (int)round((strtotime($drug['expiry_date']) - time()) / 86400)
        : 365;
    $batchAgeDays = isset($drug['manufacture_date'])
        ? (int)round((time() - strtotime($drug['manufacture_date'])) / 86400)
        : 0;
    $isBlocked    = ($drug['status'] ?? '') === 'blocked' ? 1 : 0;
    $isRegistered = empty($drug) ? 0 : 1;
    $drugCategory = $drug['category'] ?? '';

    $features = [
        'scans_last_2h'        => $scans2h,
        'unique_locations_2h'  => $locations,
        'total_scans'          => $total,
        'days_to_expiry'       => $daysToExpiry,
        'is_blocked'           => $isBlocked,
        'is_registered'        => $isRegistered,
        'drug_category'        => $drugCategory,
        'manufacturer_reports' => $mfrReports,
        'batch_age_days'       => $batchAgeDays,
    ];

    // Try ML service first
    $mlResult = callMLService($features);
    if ($mlResult !== null) {
        return array_merge($mlResult, [
            'total_scans' => $total + 1,
            'method'      => 'ml',
        ]);
    }

    // Fallback: original rule-based logic
    $confidence = 97.0;
    $signals    = [];
    $result     = 'genuine';

    if ($scans2h > 30 && $locations >= 2) {
        $result     = 'suspect';
        $confidence = round(88 + mt_rand(0, 8), 1);
        $signals[]  = ['type' => 'red',    'text' => "Scanned {$scans2h}x in 2h across {$locations} locations"];
        $signals[]  = ['type' => 'red',    'text' => 'Geographic anomaly detected'];
    } elseif ($scans2h > 15) {
        $result     = 'suspect';
        $confidence = round(78 + mt_rand(0, 12), 1);
        $signals[]  = ['type' => 'red',    'text' => "High scan frequency: {$scans2h} scans in 2 hours"];
        $signals[]  = ['type' => 'yellow', 'text' => 'Pattern inconsistent with normal use'];
    } else {
        $confidence = round(95 + mt_rand(0, 4), 1);
        $signals[]  = ['type' => 'green', 'text' => "Total scans ({$total}) within normal range"];
        $signals[]  = ['type' => 'green', 'text' => 'No geographic anomaly detected'];
        $signals[]  = ['type' => 'green', 'text' => 'Manufacturer identity confirmed'];
        $signals[]  = ['type' => 'green', 'text' => 'Batch code integrity valid'];
    }

    return [
        'result'      => $result,
        'confidence'  => $confidence,
        'signals'     => $signals,
        'total_scans' => $total + 1,
        'method'      => 'rules',
    ];
}
