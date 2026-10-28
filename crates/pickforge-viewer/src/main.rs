fn main() {
    std::process::exit(pickforge_viewer::main_entry(std::env::args_os().skip(1)));
}
