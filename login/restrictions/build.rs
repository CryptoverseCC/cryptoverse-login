fn main() {
    tonic_build::configure()
        .compile(&["proto/restrictions.proto"], &["proto"])
        .unwrap();
}
