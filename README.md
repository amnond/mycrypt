# mycrypt

A Web password manager for Password Safe v3 files, built on Joey Hewitt's excellent [libpwsafejs](https://github.com/scintill/libpwsafejs) library 
(which was only slightly modified to enable progress indication whenever loading or saving .psafe3 password files).

This project also makes use of a modified version of [aimaraJS](https://github.com/rafaelthca/aimaraJS) - Rafael Thofehrn Castro's implementation of a 
pure JavaScript TreeView component.

All application code is in index.html using plain vanilla JavaScript, and not even modern JavaScript at that...
The code also includes an example PHP code that is used to demonstrate how to serve the files to the index.html to
create a password manager on a certain URL.

### Security Notes

Also note that while .psafe3 encrypted files are considered very secure, using them on the Web requires a more in depth
security review. For anything more than a educational experience you should use this at your own risk. See the security notes
given in Joey Hewitt's own implementation for a Browser-based viewer for Password Safe v3 files [here](https://github.com/scintill/pwsafejs?tab=readme-ov-file#security-notes)

