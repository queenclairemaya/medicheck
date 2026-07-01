<?php
// ============================================================
//  MediCheck — Auth API
//  api/auth.php
//  Actions: login | logout | register | me
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
    case 'login':
        $email    = trim(strtolower($body['email'] ?? ''));
        $password = $body['password'] ?? '';

        if (!$email || !$password) {
            jsonResponse(false, 'Email and password are required', [], 400);
        }

        $db   = getDB();
        $stmt = $db->prepare("SELECT * FROM users WHERE email = ? AND is_active = 1 LIMIT 1");
        $stmt->execute([$email]);
        $user = $stmt->fetch();

        if (!$user || !password_verify($password, $user['password'])) {
            jsonResponse(false, 'Invalid email or password', [], 401);
        }

        $_SESSION['user'] = [
            'id'      => $user['id'],
            'name'    => $user['name'],
            'email'   => $user['email'],
            'role'    => $user['role'],
            'company' => $user['company'],
        ];

        jsonResponse(true, 'Login successful', [
            'user' => $_SESSION['user']
        ]);
        break;

    // ----------------------------------------------------------
    case 'logout':
        session_destroy();
        jsonResponse(true, 'Logged out');
        break;

    // ----------------------------------------------------------
    case 'register':
        $name     = trim($body['name']     ?? '');
        $email    = trim(strtolower($body['email']    ?? ''));
        $password = $body['password'] ?? '';
        $role     = $body['role']     ?? 'user';
        $company  = trim($body['company']  ?? '');
        $phone    = trim($body['phone']    ?? '');

        if (!$name || !$email || !$password) {
            jsonResponse(false, 'Name, email, and password are required', [], 400);
        }
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            jsonResponse(false, 'Invalid email address', [], 400);
        }
        if (strlen($password) < 6) {
            jsonResponse(false, 'Password must be at least 6 characters', [], 400);
        }
        if (!in_array($role, ['user', 'manufacturer'])) {
            $role = 'user'; // only admin can create admins
        }

        $db = getDB();
        $check = $db->prepare("SELECT id FROM users WHERE email = ? LIMIT 1");
        $check->execute([$email]);
        if ($check->fetch()) {
            jsonResponse(false, 'An account with this email already exists', [], 409);
        }

        $hash = password_hash($password, PASSWORD_BCRYPT);
        $stmt = $db->prepare(
            "INSERT INTO users (name, email, password, role, company, phone)
             VALUES (?, ?, ?, ?, ?, ?)"
        );
        $stmt->execute([$name, $email, $hash, $role, $company, $phone]);
        $newId = $db->lastInsertId();

        $_SESSION['user'] = [
            'id'      => (int)$newId,
            'name'    => $name,
            'email'   => $email,
            'role'    => $role,
            'company' => $company,
        ];

        jsonResponse(true, 'Account created successfully', ['user' => $_SESSION['user']], 201);
        break;

    // ----------------------------------------------------------
    case 'update_profile':
        $user = requireAuth();
        $name = trim($body['name'] ?? '');
        $email = trim(strtolower($body['email'] ?? ''));
        $phone = trim($body['phone'] ?? '');
        $company = trim($body['company'] ?? '');
        if (!$name || !$email || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            jsonResponse(false, 'Valid name and email are required', [], 400);
        }
        try {
            $db = getDB();
            $stmt = $db->prepare("UPDATE users SET name = ?, email = ?, phone = ?, company = ? WHERE id = ?");
            $stmt->execute([$name, $email, $phone, $company, $user['id']]);
            // Refresh session user data
            $_SESSION['user']['name'] = $name;
            $_SESSION['user']['email'] = $email;
            $_SESSION['user']['phone'] = $phone;
            $_SESSION['user']['company'] = $company;
            jsonResponse(true, 'Profile updated', ['user' => $_SESSION['user']]);
        } catch (Exception $e) {
            jsonResponse(false, 'Failed to update profile', [], 500);
        }
        break;

    // ----------------------------------------------------------
    case 'me':
        $user = requireAuth();
        jsonResponse(true, '', ['user' => $user]);
        break;

    // ----------------------------------------------------------
    case 'update_2fa':
        $user = requireAuth();
        $methods = $body['methods'] ?? [];
        if (!is_array($methods)) $methods = [];
        // Save to session for now
        $_SESSION['user']['two_factor'] = $methods;
        // If possible, persist to database (best-effort, table may not have column)
        try {
            $db = getDB();
            // Attempt update if column exists
            $stmt = $db->prepare("UPDATE users SET two_factor = ? WHERE id = ?");
            $stmt->execute([json_encode($methods), $user['id']]);
        } catch (Exception $e) {
            // Ignore DB errors for now — session still holds the config
        }
        jsonResponse(true, 'Two-factor settings updated');
        break;

    // ----------------------------------------------------------
    case 'change_password':
        $user    = requireAuth();
        $current = $body['current_password'] ?? '';
        $newPass = $body['new_password']     ?? '';
        $confirm = $body['confirm_password'] ?? '';

        if (!$current || !$newPass || !$confirm) {
            jsonResponse(false, 'All password fields are required', [], 400);
        }
        if (strlen($newPass) < 6) {
            jsonResponse(false, 'New password must be at least 6 characters', [], 400);
        }
        if ($newPass !== $confirm) {
            jsonResponse(false, 'New passwords do not match', [], 400);
        }

        $db   = getDB();
        $stmt = $db->prepare("SELECT password FROM users WHERE id = ? LIMIT 1");
        $stmt->execute([$user['id']]);
        $row  = $stmt->fetch();

        if (!$row || !password_verify($current, $row['password'])) {
            jsonResponse(false, 'Current password is incorrect', [], 401);
        }

        $hash = password_hash($newPass, PASSWORD_BCRYPT);
        $db->prepare("UPDATE users SET password = ? WHERE id = ?")->execute([$hash, $user['id']]);
        jsonResponse(true, 'Password changed successfully');
        break;

    // ----------------------------------------------------------
    case 'promote_to_admin':
        requireAuth('admin');
        $targetEmail = trim(strtolower($body['email'] ?? ''));
        if (!$targetEmail) jsonResponse(false, 'Email is required', [], 400);

        $db   = getDB();
        $stmt = $db->prepare("SELECT id, name FROM users WHERE email = ? LIMIT 1");
        $stmt->execute([$targetEmail]);
        $target = $stmt->fetch();
        if (!$target) jsonResponse(false, 'No user found with that email', [], 404);

        $db->prepare("UPDATE users SET role='admin' WHERE id=?")->execute([$target['id']]);
        jsonResponse(true, "User '{$target['name']}' promoted to admin");
        break;

    // ----------------------------------------------------------
    default:
        jsonResponse(false, 'Unknown action', [], 400);
}
