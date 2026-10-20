// Test driver, never shipped: compiled together with
// core/src/jobs/windows_job.cs (csc /main:JsonFixtures), it writes each
// fixture of a manifest read on stdin ({name, format, minBytes, base64} each)
// into a run folder of its own and prints the Windows helper's own
// Files.CheckArtifact entry for it, one JSON line each, in order.
// json_diff.py compares those entries with host.py's check_artifact on the
// same bytes.
//
// Usage: json-fixtures.exe <run folder>, a drive path or %TEMP%\<name>; the
// folder must not exist yet. Nothing outside it is written.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

static class JsonFixtures
{
    static int Main(string[] args)
    {
        if (args.Length != 1) { Console.Error.WriteLine("usage: json-fixtures <run folder>"); return 2; }
        string root = args[0];
        if (root.StartsWith("%TEMP%\\", StringComparison.Ordinal)) root = Path.Combine(Path.GetTempPath(), root.Substring(7));
        if (!Regex.IsMatch(root, @"^[A-Za-z]:\\[^\\]")) { Console.Error.WriteLine("the run folder must be a drive path"); return 2; }
        if (Directory.Exists(root) || File.Exists(root)) { Console.Error.WriteLine(root + " exists: give each run a new folder"); return 4; }
        Directory.CreateDirectory(root);
        JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        string text;
        using (StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false))) text = input.ReadToEnd();
        object[] fixtures = (object[])json.DeserializeObject(text);
        using (Stream output = Console.OpenStandardOutput())
        {
            byte[] head = Encoding.UTF8.GetBytes(json.Serialize(new Dictionary<string, object> { { "root", root } }) + "\n");
            output.Write(head, 0, head.Length);
            foreach (object item in fixtures)
            {
                Dictionary<string, object> fixture = (Dictionary<string, object>)item;
                string name = (string)fixture["name"];
                File.WriteAllBytes(Path.Combine(root, name), Convert.FromBase64String((string)fixture["base64"]));
                Dictionary<string, object> artifact = new Dictionary<string, object>();
                artifact["path"] = name;
                artifact["format"] = fixture["format"];
                artifact["minBytes"] = fixture["minBytes"];
                Dictionary<string, object> entry = Files.CheckArtifact(root, artifact, null);
                byte[] line = Encoding.UTF8.GetBytes(json.Serialize(entry) + "\n");
                output.Write(line, 0, line.Length);
                output.Flush();
            }
        }
        return 0;
    }
}
