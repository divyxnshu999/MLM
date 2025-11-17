CREATE DATABASE IF NOT EXISTS mlm;
USE mlm;

CREATE TABLE members (
  member_code INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100),
  email VARCHAR(100) UNIQUE,
  mobile VARCHAR(20),
  password VARCHAR(255),
  sponsor_code INT,
  left_child INT,
  right_child INT,
  left_count INT DEFAULT 0,
  right_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
