<?php
header('Content-Type: application/json');

function pwfiles() {
    return ['pwfiles' => glob('*.psafe3')];
}

if ($_SERVER["REQUEST_METHOD"] === "POST") {
    $json = json_decode(file_get_contents('php://input'), true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        http_response_code(400);
        echo json_encode(array("error" => "Invalid JSON"));
        exit();
    }
    $req = $json["req"] ?? null;
    if ($req === null) {
        http_response_code(400);
        echo json_encode(array("error" => "Missing data"));
        exit();
    }
    $response = '';
    switch ($req) {
        //------------------------------------------------------------
        case "pwfiles":
            $response = pwfiles();
            break;

        //------------------------------------------------------------
        case "get_file_b64content":
            if (!isset($json["filename"])) {
                echo json_encode(["error" => "no filename given"]);
                exit();
            }
            $file_path = $json["filename"] . '.psafe3';
            
            if (file_exists($file_path)) {
                // Get the file's contents
                $base64_content = base64_encode(file_get_contents($file_path));
                $response = ['file_b64_content' => $base64_content];
                // Send the binary data as the response
            } else {
                // Send an error message if the file doesn't exist
                $response = ['error' => "file $file_path does not exist"];
            }
            break;

        //------------------------------------------------------------
        case "set_file_b64content":
            if (!isset($json["filename"])) {
                echo json_encode(["error" => "no filename given"]);
                exit();
            }
            $file_path = $json["filename"] . '.psafe3';
            $base64_content = $json["data"];
            $binary_data = base64_decode($base64_content);
            $response = ['status' => 'ok'];
            if (file_put_contents($file_path, $binary_data) === false) {
                $response = ['status' => 'error', 'error' => 'problem writing file'];
            }
            
            break;
            
        default:
            $response = json_encode(['error' => "unknown command: $req"]);
            break;
    }

    if ($response != '') {
        echo json_encode($response);
    }
} else {
    http_response_code(405);
    echo json_encode(array("error" => "Invalid request method"));
}
?>

